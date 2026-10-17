# Builds the walkthrough GIF from rendered PNG frames: identical consecutive frames merge into one
# longer frame, every frame maps to one shared palette, and Pillow writes opaque changed-region patches.
# usage: python makegif.py FRAMEDIR FPS WIDTH OUT.gif
import hashlib, sys
from pathlib import Path
from PIL import Image

frame_dir, fps, width, out = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
paths = sorted(frame_dir.glob('f*.png'))
step_ms = 1000 // fps

frames, durations, last = [], [], None
for path in paths:
    image = Image.open(path).convert('RGB')
    image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
    digest = hashlib.sha1(image.tobytes()).digest()
    if digest == last:
        durations[-1] += step_ms
        continue
    frames.append(image); durations.append(step_ms); last = digest

# One palette for the whole animation, from a sample of frames stacked together.
sample = frames[:: max(1, len(frames) // 40)]
sheet = Image.new('RGB', (width, sum(f.height for f in sample)))
y = 0
for f in sample:
    sheet.paste(f, (0, y)); y += f.height
palette = sheet.quantize(colors=96, method=Image.Quantize.MEDIANCUT)
mapped = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
mapped[0].save(out, save_all=True, append_images=mapped[1:], duration=durations, loop=0, disposal=1, optimize=False)
print(len(paths), 'source frames ->', len(frames), 'gif frames,', sum(durations) / 1000, 's')
