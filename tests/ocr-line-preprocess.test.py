"""Geometry-only checks; run with the NDLOCR Python environment."""
import sys
import unittest
from pathlib import Path
import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "ocr"))
from line_preprocess import rectify_line


class LinePreprocessingTests(unittest.TestCase):
    def test_vertical_and_small_regions_are_unchanged(self):
        image = np.full((300, 300, 3), 255, np.uint8)
        image[50:200, 80:100] = 0
        for box in ([70, 30, 110, 230], [70, 40, 130, 100]):
            result, info = rectify_line(image, box)
            x0, y0, x1, y1 = box
            np.testing.assert_array_equal(result, image[y0:y1, x0:x1])
            self.assertFalse(info["applied"])
            self.assertEqual(info["reason"], "short-or-vertical")

    def test_blank_or_unsupported_line_falls_back(self):
        image = np.full((300, 1400, 3), 255, np.uint8)
        cv2.rectangle(image, (500, 130), (520, 150), (0, 0, 0), -1)
        result, info = rectify_line(image, [20, 100, 1320, 220])
        self.assertFalse(info["applied"])
        np.testing.assert_array_equal(result, image[100:220, 20:1320])

    def test_incompatible_component_sizes_fall_back_without_nan_fit(self):
        image = np.full((300, 1400, 3), 255, np.uint8)
        for x in range(50, 1250, 300):
            cv2.rectangle(image, (x, 130), (x + 80, 140), (0, 0, 0), -1)
            cv2.rectangle(image, (x + 130, 110), (x + 138, 170), (0, 0, 0), -1)
        result, info = rectify_line(image, [20, 80, 1320, 240])
        self.assertFalse(info["applied"])
        self.assertEqual(info["reason"], "too-few-body-components")
        np.testing.assert_array_equal(result, image[80:240, 20:1320])

    def test_very_wide_shallow_region_does_not_resize_to_zero_height(self):
        image = np.full((64, 128000, 3), 255, np.uint8)
        result, info = rectify_line(image, [0, 24, 128000, 40])
        self.assertFalse(info["applied"])
        np.testing.assert_array_equal(result, image[24:40])

    def test_remap_source_dimension_limit_falls_back_even_for_small_output(self):
        image = np.full((32768, 64, 3), 255, np.uint8)
        result, info = rectify_line(image, [0, 100, 64, 116])
        self.assertFalse(info["applied"])
        self.assertEqual(info["reason"], "source-exceeds-remap-limit")
        np.testing.assert_array_equal(result, image[100:116])

    def test_sloped_line_is_rectified_without_mutating_source_or_merging_neighbor(self):
        image = np.full((600, 1400, 3), 255, np.uint8)
        for x in range(50, 1300, 42):
            y = round(320 - .13 * x)
            cv2.rectangle(image, (x, y), (x + 25, y + 34), (0, 0, 0), -1)
            cv2.rectangle(image, (x + 7, y + 9), (x + 17, y + 22), (255, 255, 255), -1)
            cv2.rectangle(image, (x + 3, y - 21), (x + 10, y - 11), (0, 0, 0), -1)
            cv2.rectangle(image, (x, y + 160), (x + 25, y + 194), (200, 0, 0), -1)
        before = image.copy()
        result, info = rectify_line(image, [30, 140, 1330, 370])
        self.assertTrue(info["applied"], info)
        self.assertLess(result.shape[0], 130)
        self.assertAlmostEqual(info["slope"], -.13, delta=.025)
        np.testing.assert_array_equal(image, before)
        # The neighbor is drawn red so any merged pixels are unambiguous.
        red = (result[:, :, 0] > result[:, :, 1] + 50) & (result[:, :, 1] < 100)
        self.assertFalse(red.any())
        gray = cv2.cvtColor(result, cv2.COLOR_RGB2GRAY)
        _, _, stats, centers = cv2.connectedComponentsWithStats((gray < 100).astype(np.uint8))
        bodies = centers[1:][(stats[1:, 3] > 25) & (stats[1:, 4] > 300)]
        self.assertGreater(len(bodies), 20)
        self.assertLess(np.ptp(bodies[:, 1]), 5)

    def test_straight_line_keeps_exact_pixels(self):
        image = np.full((250, 1400, 3), 255, np.uint8)
        for x in range(50, 1300, 42):
            cv2.rectangle(image, (x, 100), (x + 25, 134), (0, 0, 0), -1)
        result, info = rectify_line(image, [30, 85, 1330, 150])
        self.assertFalse(info["applied"], info)
        np.testing.assert_array_equal(result, image[85:150, 30:1330])


if __name__ == "__main__":
    unittest.main()
