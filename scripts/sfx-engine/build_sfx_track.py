#!/usr/bin/env python3
"""Build a deterministic WAV track from validated, pre-computed SFX events."""

import argparse
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from pydub import AudioSegment


ENGINE_DIR = Path(__file__).resolve().parent
SFX_DIR = ENGINE_DIR / "sfx"
with (ENGINE_DIR / "sfx-catalog.json").open("r", encoding="utf-8") as source:
    SFX_CATALOG = json.load(source)
SFX_LIBRARY = {
    name: SFX_DIR / metadata["filename"]
    for name, metadata in SFX_CATALOG.items()
}


def amplitude_to_db(amplitude: float) -> float:
    """Convert a linear peak-amplitude ratio to pydub's decibel gain."""
    return 20 * math.log10(amplitude)


def positive_integer(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def reject_nonfinite_json(value: str) -> None:
    raise ValueError(f"non-finite number {value} is not allowed")


def load_events(events_path: Path, duration_ms: int) -> list[dict[str, Any]]:
    try:
        with events_path.open("r", encoding="utf-8") as source:
            raw_events = json.load(source, parse_constant=reject_nonfinite_json)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"invalid events JSON: {error}") from error

    if not isinstance(raw_events, list):
        raise ValueError("events must be a JSON list")
    if not raw_events:
        raise ValueError("events must not be empty")

    events: list[dict[str, Any]] = []
    for index, event in enumerate(raw_events):
        if not isinstance(event, dict):
            raise ValueError(f"events[{index}] must be an object")
        if set(event) != {"sfx", "at_ms"}:
            raise ValueError(f"events[{index}] must contain only sfx and at_ms")

        effect = event["sfx"]
        if not isinstance(effect, str) or effect not in SFX_LIBRARY:
            raise ValueError(f"events[{index}] has unknown effect")

        at_ms = event["at_ms"]
        if isinstance(at_ms, bool) or not isinstance(at_ms, (int, float)):
            raise ValueError(f"events[{index}].at_ms must be numeric")
        if not math.isfinite(at_ms):
            raise ValueError(f"events[{index}].at_ms must be finite")
        if at_ms < 0 or at_ms >= duration_ms:
            raise ValueError(f"events[{index}].at_ms must be within the track")

        events.append({"sfx": effect, "at_ms": int(at_ms)})
    return events


def load_sfx(name: str) -> AudioSegment:
    effect = (
        AudioSegment.from_file(SFX_LIBRARY[name], format="wav")[:1000]
        .set_frame_rate(48000)
        .set_channels(2)
        .set_sample_width(2)
    )
    if effect.max_dBFS == float("-inf"):
        raise ValueError(f"effect {name} contains no audio")
    effect = effect.apply_gain(-effect.max_dBFS)
    amplitude = SFX_CATALOG[name]["targetAmplitude"]
    effect = effect.apply_gain(amplitude_to_db(amplitude))
    return effect


def build_track(events: list[dict[str, Any]], duration_ms: int) -> AudioSegment:
    track = (
        AudioSegment.silent(duration=duration_ms, frame_rate=48000)
        .set_channels(2)
        .set_sample_width(2)
    )
    for event in events:
        track = track.overlay(load_sfx(event["sfx"]), position=event["at_ms"])
    return track[:duration_ms]


def publish_wav(track: AudioSegment, output_path: Path) -> None:
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp.wav", dir=output_path.parent
    )
    os.close(descriptor)
    temp_path = Path(temp_name)
    try:
        track.export(temp_path, format="wav")
        os.replace(temp_path, output_path)
    finally:
        temp_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a local SFX WAV track")
    parser.add_argument("--events-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration-ms", type=positive_integer, required=True)
    args = parser.parse_args()

    try:
        events = load_events(args.events_json, args.duration_ms)
        track = build_track(events, args.duration_ms)
        publish_wav(track, args.output)
    except (OSError, ValueError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
