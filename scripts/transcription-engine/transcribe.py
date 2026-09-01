#!/usr/bin/env python3
"""Strict NDJSON CLI for the local transcription engine."""

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Callable, TextIO

from engine import ModelDownloadFailed, transcribe_audio


Event = dict[str, Any]
Emit = Callable[[Event], None]


class InvalidInput(Exception):
    pass


class ProtocolViolation(Exception):
    pass


class StrictArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise InvalidInput() from None


EVENT_KEYS = {
    "phase": {"type", "phase"},
    "model-ready": {"type", "device"},
    "progress": {"type", "phase", "device", "progress"},
    "warning": {"type", "code"},
    "completed": {"type", "device"},
    "error": {"type", "code"},
}


def validate_event(event: Event) -> None:
    if not isinstance(event, dict):
        raise ProtocolViolation()
    event_type = event.get("type")
    if event_type not in EVENT_KEYS or set(event) != EVENT_KEYS[event_type]:
        raise ProtocolViolation()
    if event_type == "phase" and event["phase"] != "downloading-model":
        raise ProtocolViolation()
    if event_type in {"model-ready", "completed"} and event["device"] not in {
        "cuda",
        "cpu",
    }:
        raise ProtocolViolation()
    if event_type == "progress":
        progress = event["progress"]
        if (
            event["phase"] != "transcribing"
            or event["device"] not in {"cuda", "cpu"}
            or isinstance(progress, bool)
            or not isinstance(progress, (int, float))
            or not math.isfinite(progress)
            or progress < 0
            or progress > 1
        ):
            raise ProtocolViolation()
    if event_type == "warning" and event["code"] != "GPU_FALLBACK":
        raise ProtocolViolation()
    if event_type == "error" and event["code"] not in {
        "INVALID_INPUT",
        "MODEL_DOWNLOAD_FAILED",
        "ENGINE_FAILED",
    }:
        raise ProtocolViolation()


class ProtocolEmitter:
    def __init__(self, emit: Emit):
        self._emit = emit
        self._state = "start"
        self.latest_device: str | None = None
        self.progress_by_device: dict[str, float] = {}
        self.terminal = False

    def emit(self, event: Event) -> None:
        validate_event(event)
        event_type = event["type"]
        if self.terminal:
            raise ProtocolViolation()

        if event_type == "phase":
            if self._state != "start":
                raise ProtocolViolation()
            self._state = "model"
        elif event_type == "warning":
            if self._state not in {"model", "cuda"}:
                raise ProtocolViolation()
            self._state = "fallback"
        elif event_type == "model-ready":
            device = event["device"]
            if self._state == "model":
                self._state = device
            elif self._state == "fallback" and device == "cpu":
                self._state = "cpu"
            else:
                raise ProtocolViolation()
            self.latest_device = device
        elif event_type == "progress":
            device = event["device"]
            value = float(event["progress"])
            if self._state != device or self.latest_device != device:
                raise ProtocolViolation()
            if value < self.progress_by_device.get(device, 0.0):
                raise ProtocolViolation()
            self.progress_by_device[device] = value
        elif event_type == "completed":
            if self._state != event["device"] or self.latest_device != event["device"]:
                raise ProtocolViolation()
            self._state = "terminal"
            self.terminal = True
        elif event_type == "error":
            code = event["code"]
            valid_error = (
                (self._state == "start" and code == "INVALID_INPUT")
                or (self._state == "model" and code in {"MODEL_DOWNLOAD_FAILED", "ENGINE_FAILED"})
                or (self._state in {"cuda", "cpu", "fallback"} and code == "ENGINE_FAILED")
            )
            if not valid_error:
                raise ProtocolViolation()
            self._state = "terminal"
            self.terminal = True

        self._emit(event)


class EngineEmitter:
    def __init__(self, protocol: ProtocolEmitter):
        self._protocol = protocol
        self.terminal_attempted = False

    def __call__(self, event: Event) -> None:
        if isinstance(event, dict) and event.get("type") in {"completed", "error"}:
            self.terminal_attempted = True
            raise ProtocolViolation()
        self._protocol.emit(event)


def write_event(event: Event, *, stream: TextIO | None = None) -> None:
    validate_event(event)
    if stream is None:
        stream = sys.stdout
    print(
        json.dumps(event, ensure_ascii=True, allow_nan=False, separators=(",", ":")),
        file=stream,
        flush=True,
    )


def _is_finite_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def validate_result(result: Any) -> None:
    if not isinstance(result, dict) or set(result) != {
        "words",
        "language",
        "languageProbability",
        "device",
    }:
        raise ValueError("invalid result")
    if result["device"] not in {"cuda", "cpu"}:
        raise ValueError("invalid result")
    if not isinstance(result["language"], str) or not result["language"].strip():
        raise ValueError("invalid result")
    probability = result["languageProbability"]
    if probability is not None and (
        not _is_finite_number(probability) or probability < 0 or probability > 1
    ):
        raise ValueError("invalid result")
    if not isinstance(result["words"], list):
        raise ValueError("invalid result")

    previous_start = 0.0
    for word in result["words"]:
        if not isinstance(word, dict) or set(word) != {"text", "start", "end"}:
            raise ValueError("invalid result")
        if not isinstance(word["text"], str) or not word["text"].strip():
            raise ValueError("invalid result")
        start = word["start"]
        end = word["end"]
        if (
            not _is_finite_number(start)
            or not _is_finite_number(end)
            or start < 0
            or end <= start
            or start < previous_start
        ):
            raise ValueError("invalid result")
        previous_start = float(start)


def publish_result(
    result: dict[str, Any], output_path: Path, input_path: Path | None = None
) -> None:
    validate_result(result)
    temporary_path = Path(f"{output_path}.tmp")
    try:
        if os.path.lexists(temporary_path):
            protected_paths = [output_path]
            if input_path is not None:
                protected_paths.append(input_path)
            temporary_resolved = temporary_path.resolve()
            resolved_alias = any(
                temporary_resolved == protected_path.resolve()
                for protected_path in protected_paths
            )
            same_file_alias = any(
                protected_path.exists()
                and os.path.samefile(temporary_path, protected_path)
                for protected_path in protected_paths
            )
            if resolved_alias or same_file_alias:
                raise FileExistsError("unsafe publication temp path")
            temporary_path.unlink()

        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary_path, flags, 0o600)
        try:
            target = os.fdopen(descriptor, "w", encoding="utf-8", newline="\n")
        except Exception:
            os.close(descriptor)
            raise
        with target:
            json.dump(
                result,
                target,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = StrictArgumentParser(add_help=False)
    parser.add_argument("--input-wav", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--language", choices=("pt", "auto"), required=True)
    parser.add_argument("--preferred-device", choices=("cuda", "cpu"), required=True)
    arguments = parser.parse_args(argv)

    if arguments.input_wav.suffix.lower() != ".wav" or not arguments.input_wav.is_file():
        raise InvalidInput()
    if not arguments.output.parent.is_dir():
        raise InvalidInput()
    try:
        input_resolved = arguments.input_wav.resolve()
        output_resolved = arguments.output.resolve()
        paths_match = input_resolved == output_resolved
        if arguments.output.exists():
            paths_match = paths_match or os.path.samefile(
                arguments.input_wav, arguments.output
            )
    except OSError as error:
        raise InvalidInput() from error
    if paths_match:
        raise InvalidInput()
    arguments.input_wav = input_resolved
    arguments.output = output_resolved
    try:
        arguments.model_cache.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise InvalidInput() from error
    if not arguments.model_cache.is_dir():
        raise InvalidInput()
    return arguments


def run(
    argv: list[str],
    *,
    emit: Emit = write_event,
    transcribe_fn: Callable[..., dict[str, Any]] = transcribe_audio,
) -> int:
    protocol = ProtocolEmitter(emit)
    try:
        arguments = parse_arguments(argv)
    except (InvalidInput, OSError):
        protocol.emit({"type": "error", "code": "INVALID_INPUT"})
        return 2

    try:
        engine_emit = EngineEmitter(protocol)
        result = transcribe_fn(
            arguments.input_wav,
            arguments.model_cache,
            arguments.language,
            arguments.preferred_device,
            engine_emit,
        )
        if engine_emit.terminal_attempted:
            raise ProtocolViolation()
        validate_result(result)
        if protocol.latest_device != result["device"]:
            raise ProtocolViolation()
        publish_result(result, arguments.output, arguments.input_wav)
        protocol.emit({"type": "completed", "device": result["device"]})
        return 0
    except ModelDownloadFailed:
        protocol.emit({"type": "error", "code": "MODEL_DOWNLOAD_FAILED"})
        print("model setup failed", file=sys.stderr)
        return 1
    except Exception:
        if not protocol.terminal:
            protocol.emit({"type": "error", "code": "ENGINE_FAILED"})
        print("transcription engine failed", file=sys.stderr)
        return 1


def main() -> int:
    return run(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
