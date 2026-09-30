# Tiled HEIC regression fixture

`tiled.heic` is a synthetic 1536×1024 test pattern, not a user's photograph.
Generated on macOS with ffmpeg 9.0.1 and `sips`:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=1536x1024:rate=1' -frames:v 1 source.png
sips -s format heic source.png --out tiled.heic
```

It contains a six-tile HEIC grid. Mapping `0:v:0` produces a 512×512 corner;
automatic stream selection produces the full 1536×1024 image. Both host
conversion tests assert the JPEG dimensions using the pinned ffprobe. ffmpeg
8+ is required for HEIC tile-grid support. Windows CI explicitly ignores real
conversion tests because its non-Hermit lane does not provision ffmpeg.
