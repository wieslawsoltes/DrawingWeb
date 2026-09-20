"""Compare native and DrawingWeb PNGs without resizing, registration or hidden tolerances.
Requires Pillow; alpha is composited onto white for both images. Native export cropping,
resolution, installed fonts and DrawingWeb page export size must be aligned by the caller.
"""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

Image.MAX_IMAGE_PIXELS = 32_000_000

def load_png(path):
    if Path(path).stat().st_size > 128 * 1024 * 1024:
        raise ValueError('Input exceeds 128 MiB')
    with Image.open(path) as image:
        if image.format != 'PNG' or image.width * image.height > 32_000_000:
            raise ValueError('Expected PNG up to 32 megapixels')
        image.load()
        rgba = image.convert('RGBA')
    white = Image.new('RGBA', rgba.size, 'white')
    return Image.alpha_composite(white, rgba).convert('RGB')

def compare(reference, actual, threshold=0):
    if not 0 <= threshold <= 255:
        raise ValueError('Threshold must be in 0..255')
    if reference.size != actual.size:
        raise ValueError(f'Pixel dimensions differ: {reference.size} versus {actual.size}; no resampling is performed')
    diff = ImageChops.difference(reference, actual)
    channels = diff.split()
    maximum = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    histogram = maximum.histogram()
    count = reference.width * reference.height
    mismatches = sum(histogram[threshold + 1:])
    statistics = ImageStat.Stat(diff)
    return {'width': reference.width, 'height': reference.height, 'threshold': threshold,
            'mismatchedPixels': mismatches, 'mismatchedFraction': mismatches / count,
            'meanAbsoluteChannelError': sum(statistics.mean) / 3,
            'maximumChannelError': max(i for i, n in enumerate(histogram) if n)}, diff

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference'); parser.add_argument('actual'); parser.add_argument('output', type=Path)
    parser.add_argument('--threshold', type=int, default=0)
    parser.add_argument('--allowed-fraction', type=float, default=0)
    args = parser.parse_args()
    if not 0 <= args.allowed_fraction <= 1: parser.error('allowed-fraction must be in 0..1')
    report, diff = compare(load_png(args.reference), load_png(args.actual), args.threshold)
    args.output.mkdir()  # Never overwrite an existing comparison.
    report['allowedFraction'] = args.allowed_fraction
    report['passed'] = report['mismatchedFraction'] <= args.allowed_fraction
    (args.output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    diff.save(args.output / 'difference.png')
    print(json.dumps(report))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
