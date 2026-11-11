# SubExposureCalculator

A guided PixInsight script that tells you how long your sub-exposures need to be.

It measures your **camera** (read noise, bias level, conversion gain) and your **sky** (background rate through each filter) directly from raw frames, then calculates the sub-exposure time at which read noise stops mattering in the final stack. It works for mono cameras and for one-shot-colour cameras, where red, green and blue are measured separately.

> **Status: version 1.0.1, new.** The calculations are tested against simulated frames with known read noise, gain and sky rate. It has been run in PixInsight on macOS with a ZWO ASI2600MC Pro; other cameras and platforms have had little use so far. Please [open an issue](https://github.com/grebleem/SubExposureCalculator/issues) if something does not work.

## What you need

All frames must be **raw**: straight from the camera, not calibrated, not debayered, not stacked, and all at the same gain, offset and binning.

| Frames | How many | Notes |
|---|---|---|
| Bias | 2 single frames | Shortest exposure, sensor covered. Not a master bias. |
| Flats | 2 (optional) | Taken back to back, one third to one half of full scale. Used to measure e-/ADU. Without flats you type the value. |
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

1. **Step 1**: select the two bias frames.
2. **Step 2**: choose *Measure from two raw flat frames* and select them, or choose *Enter a value* and type the conversion gain in e-/ADU.
3. **Step 3**: add your light frames. Filters can be mixed.
4. **Step 4**: leave the options alone to start with.
5. Press **Calculate**.
6. Press **Save CSV...** to keep the results.

The **Help** button inside the script explains every step and the theory.

### Options

| Option | Meaning |
|---|---|
| Sensor | *Auto* reads the `BAYERPAT` keyword. Set Mono or a Bayer pattern by hand if the keyword is missing or wrong. |
| Sky background | *Darkest tiles* finds empty sky even when nebulosity fills much of the frame. *Whole frame median* is the simple alternative for sparse fields. |
| Target multiples | The multiples of read noise squared to calculate times for. Default `3, 5, 10`. |
| Exposure if missing | Used when a light frame has no `EXPTIME` keyword. |
| Site latitude / longitude | Optional. Used for the Moon's altitude when the frames carry no `SITELAT` / `SITELONG`. |

## Results

For every light frame and channel the script reports:

| Column | Meaning |
|---|---|
| Sky (ADU), Sky (e-) | Background above the bias level. |
| Rate (e-/s) | Sky electrons per second per pixel. Log this against Moon phase. |
| m now, Eff. | Where the frame's own exposure time already puts you. |
| t (m = ...) | Sub length needed for each target multiple. |
| Noise check | Measured background noise divided by predicted noise. Near 1.0 means the camera numbers are consistent. |
| Moon | Illuminated fraction, and altitude and distance from the target when coordinates are known. |

A `MEDIAN` row per filter and channel summarises several frames. The CSV also contains Sun altitude, target altitude and the share of clipped pixels.

## The idea in three lines

- Sky signal per sub `S` (electrons), read noise `R` (electrons), `m = S / R²`.
- Stack efficiency compared with one single long exposure: `√(m / (m + 1))`. That is 87% at m = 3, 91% at m = 5, 95% at m = 10.
- Sub length for a chosen m: `t = m × R² / P`, where `P` is the sky rate in electrons per second.

There is no single optimum. Total integration time matters far more than sub length. See [docs/THEORY.md](docs/THEORY.md) for the full explanation and for how each quantity is measured.

## Limits

- Dark current is not removed. It is negligible for cooled cameras. For warm sensors, use two darks of matching exposure in place of the bias frames.
- The Bayer pattern is used as stored in the file. `XBAYROFF` / `YBAYROFF` offsets are ignored.
- Moon and Sun positions are low-precision (a fraction of a degree), which is plenty for logging.

## For maintainers

After changing the script, raise `SEC_VERSION`, run `python3 tools/build_update.py`, then `python3 tools/check_update.py`, and commit `src/` together with the regenerated `updates/` folder.

Pushing to `main` publishes `updates/` to https://pixinsight.fmsoftware.dev/ through GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). The domain is set once in the repository's **Settings > Pages**, with Source set to *GitHub Actions*.

## Credits

Written by Bastiaan Meelberg with Claude. The method follows the calculated approach to sub-exposure length described in Charles Bracken's *The Deep-sky Imaging Primer*.

## License

[MIT](LICENSE)
