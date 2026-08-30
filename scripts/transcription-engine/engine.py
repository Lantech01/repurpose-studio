"""Pinned faster-whisper inference with local-first setup and CUDA fallback."""

import math
import re
from numbers import Real
from pathlib import Path
from typing import Any, Callable

from huggingface_hub.errors import LocalEntryNotFoundError


MODEL_ID = "Systran/faster-whisper-small"
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"

DEVICE_FAILURE_PATTERNS = (
    re.compile(
        r"^CUDA (?:driver\b.*(?:unavailable|not found|insufficient)|failed with error\b.+|"
        r"error:\s*.+|out of memory(?:\b.*)?)$",
        re.IGNORECASE,
    ),
    re.compile(r"^cuDNN failed with error CUDNN_STATUS_[A-Z_]+(?:\b.*)?$", re.IGNORECASE),
    re.compile(r"^cuBLAS failed with error CUBLAS_STATUS_[A-Z_]+(?:\b.*)?$", re.IGNORECASE),
    re.compile(
        r"^Library (?:lib)?(?:cublas|cudnn)\S* is not found or cannot be loaded$",
        re.IGNORECASE,
    ),
    re.compile(r"^Could not load library (?:lib)?(?:cublas|cudnn)\S*$", re.IGNORECASE),
    re.compile(
        r"^Requested float16 compute type, but the target device or backend "
        r"do not support efficient float16 computation\.?$",
        re.IGNORECASE,
    ),
)

Event = dict[str, Any]
Emit = Callable[[Event], None]


class ModelDownloadFailed(Exception):
    """The pinned model could not be resolved safely."""


def _download_model(*args: Any, **kwargs: Any) -> str:
    from faster_whisper.utils import download_model

    return download_model(*args, **kwargs)


def _create_model(*args: Any, **kwargs: Any) -> Any:
    from faster_whisper import WhisperModel

    return WhisperModel(*args, **kwargs)


def resolve_model(
    model_cache: Path,
    *,
    download_model_fn: Callable[..., str] = _download_model,
) -> Path:
    arguments = {
        "cache_dir": model_cache.as_posix(),
        "revision": MODEL_REVISION,
    }
    try:
        local_path = download_model_fn(
            MODEL_ID,
            **arguments,
            local_files_only=True,
        )
    except LocalEntryNotFoundError:
        try:
            local_path = download_model_fn(
                MODEL_ID,
                **arguments,
                local_files_only=False,
            )
        except Exception as error:
            raise ModelDownloadFailed() from error
    except Exception as error:
        raise ModelDownloadFailed() from error
    return Path(local_path)


def is_device_failure(error: Exception) -> bool:
    if not isinstance(error, RuntimeError):
        return False
    message = str(error).strip()
    return any(pattern.fullmatch(message) for pattern in DEVICE_FAILURE_PATTERNS)


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    converted = float(value)
    return converted if math.isfinite(converted) else None


def _model_word_number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError("invalid model word")
    converted = float(value)
    if not math.isfinite(converted):
        raise ValueError("invalid model word")
    return converted


def _run_device(
    input_wav: Path,
    model_path: Path,
    language: str,
    device: str,
    emit: Emit,
    model_factory: Callable[..., Any],
) -> dict[str, Any]:
    compute_type = "float16" if device == "cuda" else "int8"
    model = model_factory(str(model_path), device=device, compute_type=compute_type)
    emit({"type": "model-ready", "device": device})

    requested_language = "pt" if language == "pt" else None
    segments, info = model.transcribe(
        str(input_wav),
        language=requested_language,
        word_timestamps=True,
    )
    duration = _finite_number(getattr(info, "duration", None))
    words: list[dict[str, Any]] = []
    progress = 0.0
    for segment in segments:
        for word in getattr(segment, "words", None) or []:
            raw_text = getattr(word, "word", None)
            if not isinstance(raw_text, str):
                raise ValueError("invalid model word")
            start = _model_word_number(getattr(word, "start", None))
            end = _model_word_number(getattr(word, "end", None))
            text = raw_text.strip()
            if text:
                if end == start:
                    end = start + 0.001
                words.append(
                    {
                        "text": text,
                        "start": start,
                        "end": end,
                    }
                )

        segment_end = _finite_number(getattr(segment, "end", None))
        if duration is not None and duration > 0 and segment_end is not None:
            progress = max(progress, min(1.0, max(0.0, segment_end / duration)))
            emit(
                {
                    "type": "progress",
                    "phase": "transcribing",
                    "device": device,
                    "progress": progress,
                }
            )

    detected_language = getattr(info, "language", None)
    probability = _finite_number(getattr(info, "language_probability", None))
    return {
        "words": words,
        "language": detected_language,
        "languageProbability": probability,
        "device": device,
    }


def transcribe_audio(
    input_wav: Path,
    model_cache: Path,
    language: str,
    preferred_device: str,
    emit: Emit,
    *,
    download_model_fn: Callable[..., str] = _download_model,
    model_factory: Callable[..., Any] = _create_model,
) -> dict[str, Any]:
    emit({"type": "phase", "phase": "downloading-model"})
    model_path = resolve_model(model_cache, download_model_fn=download_model_fn)

    try:
        return _run_device(
            input_wav,
            model_path,
            language,
            preferred_device,
            emit,
            model_factory,
        )
    except Exception as error:
        if preferred_device != "cuda" or not is_device_failure(error):
            raise

    emit({"type": "warning", "code": "GPU_FALLBACK"})
    return _run_device(
        input_wav,
        model_path,
        language,
        "cpu",
        emit,
        model_factory,
    )
