import io
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch


ENGINE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_DIR))

import engine
import transcribe


def make_info(duration=10.0, language="pt", probability=0.95):
    return SimpleNamespace(
        duration=duration,
        language=language,
        language_probability=probability,
    )


def make_segment(end, words):
    return SimpleNamespace(
        end=end,
        words=[SimpleNamespace(word=text, start=start, end=finish) for text, start, finish in words],
    )


def successful_model(segments=None, info=None):
    model = Mock()
    model.transcribe.return_value = (
        iter(segments if segments is not None else []),
        info if info is not None else make_info(),
    )
    return model


def valid_result(device="cuda"):
    return {
        "words": [{"text": "ola", "start": 0.0, "end": 0.5}],
        "language": "pt",
        "languageProbability": 0.95,
        "device": device,
    }


class EngineTests(unittest.TestCase):
    def test_model_identity_is_immutable(self):
        self.assertEqual(engine.MODEL_ID, "Systran/faster-whisper-small")
        self.assertEqual(engine.MODEL_REVISION, "536b0662742c02347bc0e980a01041f333bce120")

    def test_populated_pinned_cache_never_enables_network(self):
        download = Mock(return_value="C:/cache/pinned-model")

        resolved = engine.resolve_model(Path("C:/cache"), download_model_fn=download)

        self.assertEqual(resolved, Path("C:/cache/pinned-model"))
        download.assert_called_once_with(
            engine.MODEL_ID,
            cache_dir="C:/cache",
            revision=engine.MODEL_REVISION,
            local_files_only=True,
        )

    def test_classified_local_cache_miss_enables_one_download(self):
        download = Mock(
            side_effect=[engine.LocalEntryNotFoundError("not cached"), "C:/cache/downloaded"]
        )

        resolved = engine.resolve_model(Path("C:/cache"), download_model_fn=download)

        self.assertEqual(resolved, Path("C:/cache/downloaded"))
        self.assertEqual(
            download.call_args_list,
            [
                call(
                    engine.MODEL_ID,
                    cache_dir="C:/cache",
                    revision=engine.MODEL_REVISION,
                    local_files_only=True,
                ),
                call(
                    engine.MODEL_ID,
                    cache_dir="C:/cache",
                    revision=engine.MODEL_REVISION,
                    local_files_only=False,
                ),
            ],
        )

    def test_unclassified_local_cache_error_does_not_enable_network(self):
        download = Mock(side_effect=OSError("corrupt cache"))

        with self.assertRaises(engine.ModelDownloadFailed):
            engine.resolve_model(Path("C:/cache"), download_model_fn=download)

        self.assertEqual(download.call_count, 1)

    def test_language_word_timestamps_normalization_and_progress(self):
        for requested, expected in (("pt", "pt"), ("auto", None)):
            with self.subTest(language=requested):
                model = successful_model(
                    segments=[
                        make_segment(2.0, [("  Ola ", 0.0, 0.4), ("   ", 0.4, 0.5)]),
                        make_segment(12.0, [(" mundo!\n", 2.0, 2.8)]),
                    ],
                    info=make_info(duration=10.0, language="pt", probability=0.91),
                )
                factory = Mock(return_value=model)
                events = []

                result = engine.transcribe_audio(
                    Path("input.wav"),
                    Path("model-cache"),
                    requested,
                    "cuda",
                    events.append,
                    download_model_fn=Mock(return_value="model-dir"),
                    model_factory=factory,
                )

                model.transcribe.assert_called_once_with(
                    "input.wav", language=expected, word_timestamps=True
                )
                self.assertEqual(
                    result["words"],
                    [
                        {"text": "Ola", "start": 0.0, "end": 0.4},
                        {"text": "mundo!", "start": 2.0, "end": 2.8},
                    ],
                )
                self.assertEqual(
                    [event for event in events if event["type"] == "progress"],
                    [
                        {
                            "type": "progress",
                            "phase": "transcribing",
                            "device": "cuda",
                            "progress": 0.2,
                        },
                        {
                            "type": "progress",
                            "phase": "transcribing",
                            "device": "cuda",
                            "progress": 1.0,
                        },
                    ],
                )

    def test_empty_speech_is_a_valid_result_without_progress(self):
        events = []

        result = engine.transcribe_audio(
            Path("input.wav"),
            Path("cache"),
            "auto",
            "cpu",
            events.append,
            download_model_fn=Mock(return_value="model-dir"),
            model_factory=Mock(return_value=successful_model(info=make_info(duration=0.0))),
        )

        self.assertEqual(result["words"], [])
        self.assertEqual([event["type"] for event in events], ["phase", "model-ready"])

    def test_cuda_success_uses_float16_without_cpu_attempt(self):
        factory = Mock(return_value=successful_model())

        result = engine.transcribe_audio(
            Path("input.wav"),
            Path("cache"),
            "pt",
            "cuda",
            Mock(),
            download_model_fn=Mock(return_value="model-dir"),
            model_factory=factory,
        )

        self.assertEqual(result["device"], "cuda")
        factory.assert_called_once_with("model-dir", device="cuda", compute_type="float16")

    def test_cuda_setup_failure_falls_back_once_to_cpu_int8(self):
        factory = Mock(
            side_effect=[RuntimeError("CUDA driver is unavailable"), successful_model()]
        )
        events = []

        result = engine.transcribe_audio(
            Path("input.wav"),
            Path("cache"),
            "pt",
            "cuda",
            events.append,
            download_model_fn=Mock(return_value="model-dir"),
            model_factory=factory,
        )

        self.assertEqual(result["device"], "cpu")
        self.assertEqual(
            factory.call_args_list,
            [
                call("model-dir", device="cuda", compute_type="float16"),
                call("model-dir", device="cpu", compute_type="int8"),
            ],
        )
        self.assertEqual(
            events,
            [
                {"type": "phase", "phase": "downloading-model"},
                {"type": "warning", "code": "GPU_FALLBACK"},
                {"type": "model-ready", "device": "cpu"},
            ],
        )

    def test_cuda_inference_oom_falls_back_once_and_restarts_progress(self):
        cuda_model = successful_model(
            segments=[make_segment(5.0, [("gpu", 0.0, 0.2)])],
            info=make_info(duration=10.0),
        )

        def failing_segments():
            yield make_segment(5.0, [("discarded", 0.0, 0.2)])
            raise RuntimeError("CUDA out of memory")

        cuda_model.transcribe.return_value = (failing_segments(), make_info(duration=10.0))
        cpu_model = successful_model(
            segments=[make_segment(2.0, [("cpu", 0.0, 0.2)])],
            info=make_info(duration=10.0),
        )
        events = []

        result = engine.transcribe_audio(
            Path("input.wav"),
            Path("cache"),
            "pt",
            "cuda",
            events.append,
            download_model_fn=Mock(return_value="model-dir"),
            model_factory=Mock(side_effect=[cuda_model, cpu_model]),
        )

        self.assertEqual(result["words"], [{"text": "cpu", "start": 0.0, "end": 0.2}])
        self.assertEqual(
            [(event["device"], event["progress"]) for event in events if event["type"] == "progress"],
            [("cuda", 0.5), ("cpu", 0.2)],
        )

    def test_device_failure_classification_uses_narrow_runtime_signatures(self):
        device_failures = [
            RuntimeError("CUDA driver is unavailable"),
            RuntimeError("CUDA failed with error out of memory"),
            RuntimeError("cuDNN failed with error CUDNN_STATUS_NOT_SUPPORTED"),
            RuntimeError("cuBLAS failed with error CUBLAS_STATUS_ALLOC_FAILED"),
            RuntimeError("Library cublas64_12.dll is not found or cannot be loaded"),
            RuntimeError("Library libcublas.so.12 is not found or cannot be loaded"),
            RuntimeError(
                "Requested float16 compute type, but the target device or backend "
                "do not support efficient float16 computation."
            ),
        ]
        non_device_failures = [
            ValueError("CUDA out of memory"),
            MemoryError("CUDA out of memory"),
            RuntimeError("failed to read C:/models/gpu/cuda/model.bin"),
            RuntimeError("decode failed for C:/videos/gpu/cuda/input.wav"),
            RuntimeError("GPU metadata is invalid"),
            RuntimeError("out of memory while decoding input"),
        ]

        for error in device_failures:
            with self.subTest(device_error=str(error)):
                self.assertTrue(engine.is_device_failure(error))
        for error in non_device_failures:
            with self.subTest(non_device_error=str(error)):
                self.assertFalse(engine.is_device_failure(error))

    def test_lazy_non_device_error_with_gpu_cuda_path_does_not_fallback(self):
        cuda_model = successful_model()

        def failing_segments():
            raise RuntimeError("decode failed for C:/videos/gpu/cuda/input.wav")
            yield

        cuda_model.transcribe.return_value = (failing_segments(), make_info())
        factory = Mock(return_value=cuda_model)
        events = []

        with self.assertRaises(RuntimeError):
            engine.transcribe_audio(
                Path("input.wav"),
                Path("cache"),
                "pt",
                "cuda",
                events.append,
                download_model_fn=Mock(return_value="model-dir"),
                model_factory=factory,
            )

        self.assertEqual(factory.call_count, 1)
        self.assertNotIn("warning", [event["type"] for event in events])

    def test_raw_model_words_are_validated_before_normalization(self):
        invalid_words = [
            (123, 0.0, 0.5),
            ("word", "0.0", 0.5),
            ("word", False, 0.5),
            ("word", 0.0, None),
            ("word", math.nan, 0.5),
            ("word", 0.0, math.inf),
        ]

        for text, start, end in invalid_words:
            with self.subTest(text=text, start=start, end=end):
                model = successful_model(
                    segments=[make_segment(1.0, [(text, start, end)])]
                )
                with self.assertRaises(ValueError):
                    engine.transcribe_audio(
                        Path("input.wav"),
                        Path("cache"),
                        "pt",
                        "cpu",
                        Mock(),
                        download_model_fn=Mock(return_value="model-dir"),
                        model_factory=Mock(return_value=model),
                    )

    def test_model_word_normalization_only_strips_surrounding_whitespace(self):
        model = successful_model(
            segments=[make_segment(1.0, [("  Ola \t mundo\n", 0, 0.5)])]
        )

        result = engine.transcribe_audio(
            Path("input.wav"),
            Path("cache"),
            "pt",
            "cpu",
            Mock(),
            download_model_fn=Mock(return_value="model-dir"),
            model_factory=Mock(return_value=model),
        )

        self.assertEqual(
            result["words"],
            [{"text": "Ola \t mundo", "start": 0.0, "end": 0.5}],
        )

    def test_zero_duration_model_word_gets_one_millisecond_span(self):
        model = successful_model(
            segments=[make_segment(3.0, [("tenho", 2.8, 2.8)])]
        )

        result = engine.transcribe_audio(
            Path("input.wav"),
            Path("cache"),
            "pt",
            "cpu",
            Mock(),
            download_model_fn=Mock(return_value="model-dir"),
            model_factory=Mock(return_value=model),
        )

        word = result["words"][0]
        self.assertEqual(word["text"], "tenho")
        self.assertEqual(word["start"], 2.8)
        self.assertAlmostEqual(word["end"] - word["start"], 0.001)

    def test_reversed_model_word_span_is_not_repaired(self):
        model = successful_model(
            segments=[make_segment(3.0, [("tenho", 2.8, 2.7)])]
        )

        result = engine.transcribe_audio(
            Path("input.wav"),
            Path("cache"),
            "pt",
            "cpu",
            Mock(),
            download_model_fn=Mock(return_value="model-dir"),
            model_factory=Mock(return_value=model),
        )

        with self.assertRaises(ValueError):
            transcribe.validate_result(result)

    def test_non_device_failure_does_not_retry(self):
        factory = Mock(side_effect=ValueError("bad model metadata"))

        with self.assertRaises(ValueError):
            engine.transcribe_audio(
                Path("input.wav"),
                Path("cache"),
                "pt",
                "cuda",
                Mock(),
                download_model_fn=Mock(return_value="model-dir"),
                model_factory=factory,
            )

        self.assertEqual(factory.call_count, 1)


class CliTests(unittest.TestCase):
    def args(self, root, preferred_device="cuda"):
        input_path = root / "input.wav"
        input_path.write_bytes(b"RIFF")
        model_cache = root / "models"
        model_cache.mkdir()
        return [
            "--input-wav",
            str(input_path),
            "--output",
            str(root / "result.partial.json"),
            "--model-cache",
            str(model_cache),
            "--language",
            "pt",
            "--preferred-device",
            preferred_device,
        ]

    def test_successful_ndjson_has_exact_grammar_and_publishes_before_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.args(root)
            output = root / "result.partial.json"
            observed = []

            def fake_engine(input_wav, model_cache, language, device, emit):
                emit({"type": "phase", "phase": "downloading-model"})
                emit({"type": "model-ready", "device": "cuda"})
                emit(
                    {
                        "type": "progress",
                        "phase": "transcribing",
                        "device": "cuda",
                        "progress": 0.5,
                    }
                )
                return valid_result()

            def observe(event):
                if event["type"] == "completed":
                    self.assertTrue(output.is_file())
                    self.assertEqual(json.loads(output.read_text(encoding="utf-8")), valid_result())
                observed.append(event)

            exit_code = transcribe.run(args, emit=observe, transcribe_fn=fake_engine)

            self.assertEqual(exit_code, 0)
            self.assertEqual(
                observed,
                [
                    {"type": "phase", "phase": "downloading-model"},
                    {"type": "model-ready", "device": "cuda"},
                    {
                        "type": "progress",
                        "phase": "transcribing",
                        "device": "cuda",
                        "progress": 0.5,
                    },
                    {"type": "completed", "device": "cuda"},
                ],
            )
            self.assertEqual(sum(event["type"] in {"completed", "error"} for event in observed), 1)
            self.assertEqual(list(root.glob(".transcription-result-*.tmp")), [])

    def test_zero_duration_model_word_publishes_as_one_millisecond_span(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.args(root, preferred_device="cpu")
            output = root / "result.partial.json"
            observed = []
            model = successful_model(
                segments=[make_segment(3.0, [("tenho", 2.8, 2.8)])]
            )

            def transcribe_with_mocked_model(input_wav, model_cache, language, device, emit):
                return engine.transcribe_audio(
                    input_wav,
                    model_cache,
                    language,
                    device,
                    emit,
                    download_model_fn=Mock(return_value="model-dir"),
                    model_factory=Mock(return_value=model),
                )

            with patch.object(sys, "stderr", io.StringIO()):
                exit_code = transcribe.run(
                    args,
                    emit=observed.append,
                    transcribe_fn=transcribe_with_mocked_model,
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(observed[-1], {"type": "completed", "device": "cpu"})
            published_word = json.loads(output.read_text(encoding="utf-8"))["words"][0]
            self.assertEqual(published_word["text"], "tenho")
            self.assertEqual(published_word["start"], 2.8)
            self.assertGreater(published_word["end"], published_word["start"])
            self.assertAlmostEqual(
                published_word["end"] - published_word["start"], 0.001
            )

    def test_fallback_ndjson_order_and_schema_are_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            observed = []

            def fake_engine(input_wav, model_cache, language, device, emit):
                emit({"type": "phase", "phase": "downloading-model"})
                emit({"type": "warning", "code": "GPU_FALLBACK"})
                emit({"type": "model-ready", "device": "cpu"})
                emit(
                    {
                        "type": "progress",
                        "phase": "transcribing",
                        "device": "cpu",
                        "progress": 1.0,
                    }
                )
                return valid_result("cpu")

            exit_code = transcribe.run(
                self.args(root), emit=observed.append, transcribe_fn=fake_engine
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(
                observed,
                [
                    {"type": "phase", "phase": "downloading-model"},
                    {"type": "warning", "code": "GPU_FALLBACK"},
                    {"type": "model-ready", "device": "cpu"},
                    {
                        "type": "progress",
                        "phase": "transcribing",
                        "device": "cpu",
                        "progress": 1.0,
                    },
                    {"type": "completed", "device": "cpu"},
                ],
            )
            expected_keys = {
                "phase": {"type", "phase"},
                "warning": {"type", "code"},
                "model-ready": {"type", "device"},
                "progress": {"type", "phase", "device", "progress"},
                "completed": {"type", "device"},
            }
            for event in observed:
                self.assertEqual(set(event), expected_keys[event["type"]])

    def test_protocol_rejects_every_illegal_transition(self):
        phase = {"type": "phase", "phase": "downloading-model"}
        cuda_ready = {"type": "model-ready", "device": "cuda"}
        cpu_ready = {"type": "model-ready", "device": "cpu"}
        warning = {"type": "warning", "code": "GPU_FALLBACK"}
        cuda_progress = {
            "type": "progress",
            "phase": "transcribing",
            "device": "cuda",
            "progress": 0.5,
        }
        cases = [
            ([], warning),
            ([], cpu_ready),
            ([phase], phase),
            ([phase], cuda_progress),
            ([phase], {"type": "completed", "device": "cpu"}),
            ([phase, cpu_ready], cuda_ready),
            ([phase, cuda_ready], cpu_ready),
            ([phase, cuda_ready], cuda_ready),
            ([phase, cuda_ready, warning], cuda_progress),
            ([phase, cuda_ready, warning], {"type": "completed", "device": "cuda"}),
            ([phase, cuda_ready, warning], warning),
            ([phase, warning], cuda_ready),
            ([phase, warning], cuda_progress),
            ([phase, cpu_ready, {"type": "completed", "device": "cpu"}], cpu_ready),
            ([{"type": "error", "code": "INVALID_INPUT"}], phase),
        ]

        for prefix, illegal_event in cases:
            with self.subTest(prefix=prefix, illegal_event=illegal_event):
                observed = []
                protocol = transcribe.ProtocolEmitter(observed.append)
                for event in prefix:
                    protocol.emit(event)
                with self.assertRaises(transcribe.ProtocolViolation):
                    protocol.emit(illegal_event)
                self.assertEqual(observed, prefix)

    def test_fallback_warning_accepts_only_cpu_ready_or_safe_error(self):
        phase = {"type": "phase", "phase": "downloading-model"}
        warning = {"type": "warning", "code": "GPU_FALLBACK"}
        accepted_endings = [
            [{"type": "model-ready", "device": "cpu"}],
            [{"type": "error", "code": "ENGINE_FAILED"}],
        ]

        for ending in accepted_endings:
            with self.subTest(ending=ending):
                observed = []
                protocol = transcribe.ProtocolEmitter(observed.append)
                for event in [phase, warning, *ending]:
                    protocol.emit(event)
                self.assertEqual(observed, [phase, warning, *ending])

    def test_cpu_failure_after_warning_emits_one_safe_terminal_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            observed = []

            def fake_engine(input_wav, model_cache, language, device, emit):
                emit({"type": "phase", "phase": "downloading-model"})
                emit({"type": "warning", "code": "GPU_FALLBACK"})
                raise RuntimeError(f"private failure at {input_wav}")

            stderr = io.StringIO()
            with patch.object(sys, "stderr", stderr):
                exit_code = transcribe.run(
                    self.args(root), emit=observed.append, transcribe_fn=fake_engine
                )

            self.assertEqual(exit_code, 1)
            self.assertEqual(
                observed,
                [
                    {"type": "phase", "phase": "downloading-model"},
                    {"type": "warning", "code": "GPU_FALLBACK"},
                    {"type": "error", "code": "ENGINE_FAILED"},
                ],
            )
            self.assertNotIn(str(root), stderr.getvalue())
            self.assertNotIn("private failure", stderr.getvalue())

    def test_model_download_failure_has_classified_terminal_event(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            observed = []

            def fake_engine(input_wav, model_cache, language, device, emit):
                emit({"type": "phase", "phase": "downloading-model"})
                raise engine.ModelDownloadFailed()

            with patch.object(sys, "stderr", io.StringIO()):
                exit_code = transcribe.run(
                    self.args(root), emit=observed.append, transcribe_fn=fake_engine
                )

            self.assertEqual(exit_code, 1)
            self.assertEqual(
                observed,
                [
                    {"type": "phase", "phase": "downloading-model"},
                    {"type": "error", "code": "MODEL_DOWNLOAD_FAILED"},
                ],
            )

    def test_engine_cannot_emit_completed_before_result_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "result.partial.json"
            observed = []

            def fake_engine(input_wav, model_cache, language, device, emit):
                emit({"type": "phase", "phase": "downloading-model"})
                emit({"type": "model-ready", "device": "cuda"})
                try:
                    emit({"type": "completed", "device": "cuda"})
                except transcribe.ProtocolViolation:
                    pass
                return valid_result()

            with patch.object(sys, "stderr", io.StringIO()):
                exit_code = transcribe.run(
                    self.args(root), emit=observed.append, transcribe_fn=fake_engine
                )

            self.assertEqual(exit_code, 1)
            self.assertEqual(
                observed,
                [
                    {"type": "phase", "phase": "downloading-model"},
                    {"type": "model-ready", "device": "cuda"},
                    {"type": "error", "code": "ENGINE_FAILED"},
                ],
            )
            self.assertFalse(output.exists())

    def test_engine_cannot_publish_after_attempting_terminal_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "result.partial.json"
            observed = []

            def fake_engine(input_wav, model_cache, language, device, emit):
                emit({"type": "phase", "phase": "downloading-model"})
                emit({"type": "model-ready", "device": "cuda"})
                try:
                    emit({"type": "error", "code": "ENGINE_FAILED"})
                except transcribe.ProtocolViolation:
                    pass
                return valid_result()

            def observe(event):
                if event["type"] == "error":
                    self.assertFalse(output.exists())
                observed.append(event)

            with patch.object(sys, "stderr", io.StringIO()):
                exit_code = transcribe.run(
                    self.args(root), emit=observe, transcribe_fn=fake_engine
                )

            self.assertEqual(exit_code, 1)
            self.assertEqual(
                observed,
                [
                    {"type": "phase", "phase": "downloading-model"},
                    {"type": "model-ready", "device": "cuda"},
                    {"type": "error", "code": "ENGINE_FAILED"},
                ],
            )
            self.assertFalse(output.exists())

    def test_invalid_cli_input_emits_only_invalid_input(self):
        observed = []

        exit_code = transcribe.run(
            ["--input-wav", "secret-not-a-wave.mp3", "--unknown", "value"],
            emit=observed.append,
            transcribe_fn=Mock(),
        )

        self.assertEqual(exit_code, 2)
        self.assertEqual(observed, [{"type": "error", "code": "INVALID_INPUT"}])

    def test_output_aliases_and_hard_links_cannot_overwrite_input_wav(self):
        for alias_kind in ("resolved", "textual", "hard-link"):
            with self.subTest(alias_kind=alias_kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                args = self.args(root)
                input_wav = Path(args[1])
                original_wav = input_wav.read_bytes()
                if alias_kind == "resolved":
                    output = input_wav.resolve()
                elif alias_kind == "textual":
                    nested = root / "nested"
                    nested.mkdir()
                    output = nested / ".." / input_wav.name
                else:
                    output = root / "input-hard-link.json"
                    os.link(input_wav, output)
                args[3] = str(output)

                observed = []
                exit_code = transcribe.run(
                    args,
                    emit=observed.append,
                    transcribe_fn=Mock(return_value=valid_result()),
                )

                self.assertEqual(exit_code, 2)
                self.assertEqual(observed, [{"type": "error", "code": "INVALID_INPUT"}])
                self.assertEqual(input_wav.read_bytes(), original_wav)

    def test_stdout_is_one_compact_json_object_per_line(self):
        stream = io.StringIO()
        event = {"type": "error", "code": "ENGINE_FAILED"}

        transcribe.write_event(event, stream=stream)

        self.assertEqual(stream.getvalue(), '{"type":"error","code":"ENGINE_FAILED"}\n')

    def test_complete_success_stdout_is_only_valid_ndjson(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def fake_engine(input_wav, model_cache, language, device, emit):
                emit({"type": "phase", "phase": "downloading-model"})
                emit({"type": "model-ready", "device": "cuda"})
                return valid_result()

            stdout = io.StringIO()
            stderr = io.StringIO()
            with patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
                exit_code = transcribe.run(self.args(root), transcribe_fn=fake_engine)

            lines = stdout.getvalue().splitlines()
            self.assertEqual(exit_code, 0)
            self.assertEqual(
                [json.loads(line) for line in lines],
                [
                    {"type": "phase", "phase": "downloading-model"},
                    {"type": "model-ready", "device": "cuda"},
                    {"type": "completed", "device": "cuda"},
                ],
            )
            self.assertTrue(all(line == line.strip() for line in lines))
            self.assertNotIn(str(root), stdout.getvalue())
            self.assertEqual(stderr.getvalue(), "")

    def test_complete_failure_stdout_is_only_safe_valid_ndjson(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def fake_engine(input_wav, model_cache, language, device, emit):
                emit({"type": "phase", "phase": "downloading-model"})
                raise RuntimeError(f"private exception at {input_wav}")

            stdout = io.StringIO()
            stderr = io.StringIO()
            with patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
                exit_code = transcribe.run(self.args(root), transcribe_fn=fake_engine)

            lines = stdout.getvalue().splitlines()
            self.assertEqual(exit_code, 1)
            self.assertEqual(
                [json.loads(line) for line in lines],
                [
                    {"type": "phase", "phase": "downloading-model"},
                    {"type": "error", "code": "ENGINE_FAILED"},
                ],
            )
            self.assertNotIn(str(root), stdout.getvalue())
            self.assertNotIn("private exception", stdout.getvalue())
            self.assertEqual(stderr.getvalue(), "transcription engine failed\n")

    def test_result_publication_fsyncs_temp_file_before_atomic_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "result.partial.json"
            order = []
            real_fsync = os.fsync
            real_replace = os.replace

            def record_fsync(descriptor):
                order.append("fsync")
                return real_fsync(descriptor)

            def record_replace(source, destination):
                order.append("replace")
                return real_replace(source, destination)

            with patch.object(transcribe.os, "fsync", side_effect=record_fsync), patch.object(
                transcribe.os, "replace", side_effect=record_replace
            ):
                transcribe.publish_result(valid_result(), output)

            self.assertEqual(order, ["fsync", "replace"])
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), valid_result())
            self.assertEqual(list(root.glob(".transcription-result-*.tmp")), [])

    def test_publication_reuses_and_cleans_deterministic_temp_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "result.partial.json"
            publication_temp = Path(f"{output}.tmp")
            publication_temp.write_text("stale forced-termination data", encoding="utf-8")
            replaced_from = []
            real_replace = os.replace

            def record_replace(source, destination):
                replaced_from.append(Path(source))
                return real_replace(source, destination)

            with patch.object(transcribe.os, "replace", side_effect=record_replace):
                transcribe.publish_result(valid_result(), output)

            self.assertEqual(replaced_from, [publication_temp])
            self.assertFalse(publication_temp.exists())
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), valid_result())

    def test_publication_cleans_deterministic_temp_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "result.partial.json"
            publication_temp = Path(f"{output}.tmp")

            def fail_replace(source, destination):
                self.assertEqual(Path(source), publication_temp)
                self.assertTrue(publication_temp.is_file())
                raise OSError("replace failed")

            with patch.object(transcribe.os, "replace", side_effect=fail_replace):
                with self.assertRaises(OSError):
                    transcribe.publish_result(valid_result(), output)

            self.assertFalse(publication_temp.exists())
            self.assertFalse(output.exists())

    def test_publication_creates_temp_exclusively_with_safe_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "result.partial.json"
            publication_temp = Path(f"{output}.tmp")
            open_calls = []
            real_open = os.open

            def record_open(path, flags, mode=0o777):
                open_calls.append((Path(path), flags, mode))
                return real_open(path, flags, mode)

            with patch.object(transcribe.os, "open", side_effect=record_open):
                transcribe.publish_result(valid_result(), output)

            self.assertEqual(len(open_calls), 1)
            opened_path, flags, mode = open_calls[0]
            self.assertEqual(opened_path, publication_temp)
            self.assertTrue(flags & os.O_CREAT)
            self.assertTrue(flags & os.O_EXCL)
            self.assertEqual(mode, 0o600)

    def test_publication_temp_hardlink_cannot_overwrite_input_or_output(self):
        for alias_kind in ("input", "output"):
            with self.subTest(alias_kind=alias_kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                args = self.args(root)
                input_wav = Path(args[1])
                output = Path(args[3])
                output.write_text("existing output", encoding="utf-8")
                publication_temp = Path(f"{output}.tmp")
                alias_target = input_wav if alias_kind == "input" else output
                original_input = input_wav.read_bytes()
                original_output = output.read_bytes()
                os.link(alias_target, publication_temp)
                observed = []

                with patch.object(sys, "stderr", io.StringIO()):
                    exit_code = transcribe.run(
                        args, emit=observed.append, transcribe_fn=self._successful_engine
                    )

                self.assertEqual(exit_code, 1)
                self.assertEqual(observed[-1], {"type": "error", "code": "ENGINE_FAILED"})
                self.assertEqual(input_wav.read_bytes(), original_input)
                self.assertEqual(output.read_bytes(), original_output)
                self.assertFalse(publication_temp.exists())

    def test_publication_temp_symlink_cannot_overwrite_input_or_output(self):
        with tempfile.TemporaryDirectory() as probe_directory:
            probe_root = Path(probe_directory)
            probe_target = probe_root / "target"
            probe_link = probe_root / "link"
            probe_target.touch()
            try:
                probe_link.symlink_to(probe_target)
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symlinks unsupported: {error}")

        for alias_kind in ("input", "output"):
            with self.subTest(alias_kind=alias_kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                args = self.args(root)
                input_wav = Path(args[1])
                output = Path(args[3])
                output.write_text("existing output", encoding="utf-8")
                publication_temp = Path(f"{output}.tmp")
                alias_target = input_wav if alias_kind == "input" else output
                original_input = input_wav.read_bytes()
                original_output = output.read_bytes()
                publication_temp.symlink_to(alias_target)
                observed = []

                with patch.object(sys, "stderr", io.StringIO()):
                    exit_code = transcribe.run(
                        args, emit=observed.append, transcribe_fn=self._successful_engine
                    )

                self.assertEqual(exit_code, 1)
                self.assertEqual(observed[-1], {"type": "error", "code": "ENGINE_FAILED"})
                self.assertEqual(input_wav.read_bytes(), original_input)
                self.assertEqual(output.read_bytes(), original_output)
                self.assertFalse(publication_temp.exists())

    @staticmethod
    def _successful_engine(input_wav, model_cache, language, device, emit):
        emit({"type": "phase", "phase": "downloading-model"})
        emit({"type": "model-ready", "device": "cuda"})
        return valid_result()

    def test_result_validator_rejects_nonfinite_and_unknown_data(self):
        invalid = valid_result()
        invalid["unknown"] = True
        with self.assertRaises(ValueError):
            transcribe.validate_result(invalid)

        invalid = valid_result()
        invalid["words"][0]["start"] = math.nan
        with self.assertRaises(ValueError):
            transcribe.validate_result(invalid)


if __name__ == "__main__":
    unittest.main()
