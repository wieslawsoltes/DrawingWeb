"""Regression checks for strict, independently useful PNG comparison."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'compare-png.py'
spec = importlib.util.spec_from_file_location('compare_png', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PngComparisonTests(unittest.TestCase):
    def test_exact_match(self):
        a = Image.new('RGB', (2, 2), (12, 34, 56))
        report, diff = module.compare(a, a.copy())
        self.assertEqual(report['mismatchedPixels'], 0)
        self.assertEqual(report['maximumChannelError'], 0)
        self.assertIsNone(diff.getbbox())

    def test_channel_threshold_is_explicit_and_inclusive(self):
        a = Image.new('RGB', (2, 2), (10, 20, 30))
        b = a.copy(); b.putpixel((0, 0), (15, 20, 30))
        report, _ = module.compare(a, b, 4)
        self.assertEqual(report['mismatchedPixels'], 1)
        self.assertEqual(report['mismatchedFraction'], 0.25)
        self.assertEqual(report['maximumChannelError'], 5)
        self.assertAlmostEqual(report['meanAbsoluteChannelError'], 5 / 12)
        self.assertEqual(module.compare(a, b, 5)[0]['mismatchedPixels'], 0)

    def test_dimensions_and_invalid_threshold_are_rejected(self):
        a = Image.new('RGB', (2, 2))
        with self.assertRaisesRegex(ValueError, 'no resampling'):
            module.compare(a, Image.new('RGB', (3, 2)))
        for value in (-1, 256):
            with self.assertRaises(ValueError): module.compare(a, a, value)

    def test_alpha_is_composited_and_non_png_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'image.png'
            Image.new('RGBA', (1, 1), (0, 0, 0, 0)).save(p)
            self.assertEqual(module.load_png(p).getpixel((0, 0)), (255, 255, 255))
            Image.new('RGB', (1, 1)).save(p, 'JPEG')
            with self.assertRaisesRegex(ValueError, 'Expected PNG'): module.load_png(p)

    def test_cli_reports_failure_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); a = root / 'a.png'; b = root / 'b.png'; out = root / 'out'
            Image.new('RGB', (2, 2), 'white').save(a)
            Image.new('RGB', (2, 2), 'black').save(b)
            result = subprocess.run([sys.executable, str(SCRIPT), str(a), str(b), str(out)], capture_output=True)
            self.assertEqual(result.returncode, 1)
            report = json.loads((out / 'report.json').read_text())
            self.assertFalse(report['passed']); self.assertEqual(report['mismatchedFraction'], 1)
            self.assertTrue((out / 'difference.png').exists())
            original = (out / 'report.json').read_bytes()
            result = subprocess.run([sys.executable, str(SCRIPT), str(a), str(a), str(out)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((out / 'report.json').read_bytes(), original)

if __name__ == '__main__': unittest.main()
