# SubExposureCalculator

A guided PixInsight script that tells you how long your sub-exposures need to be.

It measures your **camera** (read noise, bias level, conversion gain) and your **sky** (background rate through each filter) directly from raw frames, then calculates the sub-exposure time at which read noise stops mattering in the final stack. It works for mono cameras and for one-shot-colour cameras, where red, green and blue are measured separately.

> **Status: version 1.0.2, new.** The calculations are tested against simulated frames with known read noise, gain and sky rate. It has been run in PixInsight on macOS with a ZWO ASI2600MC Pro; other cameras and platforms have had little use so far. Please [open an issue](https://github.com/grebleem/SubExposureCalculator/issues) if something does not work.

## What you need

All frames must be **raw**: straight from the camera, not calibrated, not debayered, not stacked, and all at the same gain, offset and binning.

| Frames | How many | Notes |
|---|---|---|
| Bias | 2 or more single frames | Shortest exposure, sensor covered. Not a master bias. More frames make the camera measurement firmer. |
| Flats | 2 or more (optional) | Taken back to back, one third to one half of full scale, through any filters. Used to measure e-/ADU. Without flats you type the value. |
| Lights | 1 or more | Ordinary subs, any target. Exposure time and filter are read from the FITS header. |

## Install

### From PixInsight's update system (recommended)

1. In PixInsight choose **RESOURCES > Updates > Manage Repositories**.
2. Click **Add** and paste this address, including the final slash:

   ```
   https://pixinsight.fmsoftware.dev/
   ```

3. Choose **RESOURCES > Updates > Check for Updates** and apply the update.
4. Restart PixInsight. The script is now at **SCRIPT > Utilities > SubExposureCalculator**, and later versions arrive through the same update check.

The repository is not signed, so PixInsight may show a warning before installing.

### By hand

1. Download [`src/SubExposureCalculator.js`](src/SubExposureCalculator.js).
2. In PixInsight choose **SCRIPT > Execute Script File...** and select it.

## Use

1. **Step 1, the first time**: press **New...**, add your bias frames, then add your flat frames or choose *Enter a value* and type the conversion gain in e-/ADU. Press **Measure and save**. The camera now appears in the list.
2. **Step 1, from then on**: choose the camera in the list.
3. **Step 2**: add your light frames. Filters can be mixed.
4. **Step 3**: leave the options alone to start with.
5. Press **Calculate**. A suggested sub-exposure appears above the table.
6. Press **Graph...** to see how efficiency grows with sub length, per channel.
7. Press **Save CSV...** to keep the results.

The **Help** button inside the script explains every step and the theory.

### The camera list

Bias level, read noise and conversion gain belong to a camera at one gain, offset and binning, not to a night. Each entry in the camera list is one such measurement. It is saved, also after closing PixInsight, so a calculation only has to read the light frames. Measure a new entry after changing gain, offset or binning.

- **More frames, firmer numbers.** Give the *New* window as many bias and flat frames as you like. Bias frames are used two at a time and the median over the pairs is taken, so one odd frame or a cosmic ray hit cannot move the result. Flat frames are paired with a neighbour through the same filter at the same brightness. Flats through different filters all count towards one gain, because the gain belongs to the camera and not to the filter. The results show how well the pairs agree and the gain per filter.
- **Export...** saves the selected camera as a small file, to keep it or to use it on another computer. **Import...** adds a camera from such a file.
- **Delete** removes a camera from the list. Your frames are never touched.

The results always name the camera that was used and say when and from how many frames it was measured.

### Choosing the background yourself

By default the script finds the sky background on its own. To use a patch of sky you pick:

1. Open a raw light frame in PixInsight and draw a preview on empty sky, 100 x 100 pixels or more. Keep away from the corners, where a raw frame is darker from vignetting.
2. Start the script. The preview has to exist before the script starts, because its window blocks the rest of PixInsight while it is open.
3. Set *Sky background* to *Preview (your own background)* and choose the preview in the list next to it. The image it belongs to is added to the light frames.

The same rectangle is used in every light frame in the list, so they should share the same framing.

### Options

| Option | Meaning |
|---|---|
| Sensor (in the *New* camera window) | *Auto* reads the `BAYERPAT` keyword. Set Mono or a Bayer pattern by hand if the keyword is missing or wrong. |
| Sky background | *Darkest tiles* finds empty sky even when nebulosity fills much of the frame. *Whole frame median* is the simple alternative for sparse fields. *Preview* uses the rectangle of a preview you drew on an open raw light frame. |
| Target multiples | The multiples of read noise squared to calculate times for. Default `3, 5, 10`. The middle one is used for the suggested sub-exposure; the lowest and highest mark the range around it. |
| Exposure if missing | Used when a light frame has no `EXPTIME` keyword. |
| Site latitude / longitude | Optional. Used for the Moon's altitude when the frames carry no `SITELAT` / `SITELONG`. |

## Results

### Suggested sub-exposure

Above the table the script suggests a sub length per filter, rounded to common values such as 120, 180 or 300 s. It is the time needed to reach the middle one of your target multiples, together with the limits within which a different length is still sensible.

The suggestion is usually a range, for example "about 6 to 9 min". The time depends on the read noise squared, and the script measures two read noise figures. The short end uses the typical pixel, the long end the RMS of all pixels, noisy ones included. A stack lands between the two, nearer the long end if you dither. When both round to the same sub length, a single time is shown.

A colour camera takes one exposure for red, green and blue together. The channel whose sky builds up most slowly against its read noise therefore sets the time, and the other two end up above the target. The results name that channel and show where each channel lands at each end.

The **Graph...** button plots efficiency against sub length, one curve per channel, with the suggested range, the exposure of your frames and your target multiples marked, and a table of each channel's efficiency at both ends.

The suggestion is calculated from your frames and your chosen multiple. It is not an optimum, and it holds for the sky as it was when the frames were taken.

### The table

For every light frame and channel the script reports:

| Column | Meaning |
|---|---|
| Sky (ADU), Sky (e-) | Background above the bias level. |
| Rate (e-/s) | Sky electrons per second per pixel. Log this against Moon phase. |
| m now, Eff. | Where the frame's own exposure time already puts you. |
| t (m = ...) | Sub length needed for each target multiple. |
| Noise check | Measured background noise divided by predicted noise. Near 1.0 means the camera numbers are consistent. |
| Moon | Illuminated fraction, and altitude and distance from the target when coordinates are known. |

A `MEDIAN` row per filter and channel summarises several frames. The CSV also contains Sun altitude, target altitude, the share of clipped pixels and, in its last column, how the background was found.

## The idea in three lines

- Sky signal per sub `S` (electrons), read noise `R` (electrons), `m = S / R²`.
- Stack efficiency compared with one single long exposure: `√(m / (m + 1))`. That is 87% at m = 3, 91% at m = 5, 95% at m = 10.
- Sub length for a chosen m: `t = m × R² / P`, where `P` is the sky rate in electrons per second.

There is no single optimum. Total integration time matters far more than sub length. See [docs/THEORY.md](docs/THEORY.md) for the full explanation and for how each quantity is measured.

## Limits

- 12 and 14 bit cameras whose files are scaled to 16 bit are detected and measured in the camera's own steps; the results state the bit depth found. Files that hold 12 or 14 bit values unscaled, as some DSLR conversions do, are measured correctly, but saturated flats and clipped stars are not flagged for them.
- A conversion gain you type is taken per ADU as stored in the file. Charts for 12 and 14 bit cameras usually give it per ADU of the camera: divide by 16 or 4 when the files are scaled to 16 bit. The results show both figures so you can check.
- Dark current is not removed. It is negligible for cooled cameras. For warm sensors, use two darks of matching exposure in place of the bias frames.
- The Bayer pattern is used as stored in the file. `XBAYROFF` / `YBAYROFF` offsets are ignored.
- Moon and Sun positions are low-precision (a fraction of a degree), which is plenty for logging.

## For maintainers

Two Node tests run outside PixInsight. `node tests/test_engine.js` feeds simulated frames from cameras with known read noise, gain and sky rate to the calculation and prints measured against true values. `node tests/test_ui.js` builds the dialogs against stand-in controls and draws the graph to SVG files; it catches JavaScript mistakes but cannot prove that a PixInsight call is right, so try the script in PixInsight before a release.

After changing the script, raise `SEC_VERSION`, run both tests, then `python3 tools/build_update.py` and `python3 tools/check_update.py`, and commit `src/` together with the regenerated `updates/` folder.

Pushing to `main` publishes `updates/` to https://pixinsight.fmsoftware.dev/ through GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). The domain is set once in the repository's **Settings > Pages**, with Source set to *GitHub Actions*.

## Credits

Written by Bastiaan Meelberg with Claude. The method follows the calculated approach to sub-exposure length described in Charles Bracken's *The Deep-sky Imaging Primer*.

## License

[MIT](LICENSE)
