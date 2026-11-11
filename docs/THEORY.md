# Theory and method

## Why sub-exposure length matters at all

A deep-sky image is built from many sub-exposures. Almost every source of noise in those subs depends only on the total number of photons collected, so it does not care how the night is divided up. One source is different: **read noise**. It is added once per frame when the sensor is read out, whatever the exposure time. Sixty one-minute subs pay that price sixty times; one hour-long sub pays it once.

Long subs have their own costs. Bright stars and galaxy cores saturate, and a single gust of wind, cloud or satellite ruins more of your night. Many short subs also give outlier rejection and dithering more to work with.

So the practical question is: **how long must a sub be before the read noise it carries no longer matters?**

## The efficiency of a stack

Take one background pixel.

- `R` is the read noise in electrons.
- `S` is the sky background collected in one sub, in electrons.

The sky signal has shot noise of `√S`. Independent noise sources add in quadrature, so the background noise in one sub is

```
noise per sub = √(S + R²)
```

Stack `N` subs and the signal grows by `N` while the noise grows by `√N`. Now imagine one single exposure of the same total length: it collects `N × S` sky electrons and one dose of read noise, which is negligible next to `N × S`. Dividing the signal-to-noise ratio of the real stack by that of the ideal single exposure, everything cancels except

```
efficiency = √( S / (S + R²) ) = √( m / (m + 1) )        with  m = S / R²
```

`m` is simply the sky background expressed as a multiple of the read noise squared.

| m | Efficiency |
|---|---|
| 1 | 71% |
| 3 | 87% |
| 5 | 91% |
| 10 | 95% |
| 20 | 98% |
| 50 | 99% |

Returns diminish fast. Going from m = 3 to m = 10 means subs more than three times as long for about 8% better signal-to-noise ratio. The choice of m is a preference, not an optimum.

## From m to seconds

If the sky delivers `P` electrons per second into a pixel, a sub of `t` seconds collects `S = P × t`. Solving for the time that reaches a chosen m:

```
t = m × R² / P
```

`P` depends on your telescope's focal ratio, pixel size, filter, light pollution, the Moon, and how high the target is. It has to be measured, and measured again when any of those change. `R` depends on the camera and its gain setting.

## How the script measures each quantity

All statistics are taken per channel. For a colour sensor the red, green and blue pixels of the Bayer mosaic are separated by position, with no interpolation; the two green positions are pooled.

### Bias level

The median of the two bias frames. Cameras add this pedestal (the "offset") so that noise never produces negative values. It must be subtracted before ADU can be converted to electrons.

### Read noise

One bias frame is subtracted from the other, pixel by pixel. Anything fixed (the pedestal, column patterns, warm pixels) cancels. What remains is random noise from two frames, so

```
R (ADU) = standard deviation( bias1 − bias2 ) / √2
R (e-)  = R (ADU) × gain
```

Two figures are reported. The *typical pixel* value is sigma-clipped at 5 sigma, so cosmic ray hits and the small share of noisy pixels found on every CMOS sensor do not inflate it; this is the value used for the results. The *RMS of all pixels* is the plain, unclipped figure and is closer to what manufacturers publish. When the two differ noticeably, the effective read noise for your faintest detail lies between them, and you can judge the effect by comparing the times for neighbouring target multiples. A master bias cannot be used: stacking averages away the very noise being measured.

### Conversion gain (e-/ADU)

Photon arrival follows Poisson statistics: measured in electrons, the variance of a signal equals the signal. In ADU, with `g` electrons per ADU, a signal of `L` ADU therefore has a shot-noise variance of `L / g`. Rearranged:

```
g = L / (shot-noise variance in ADU)
```

Two flats give both terms. `L` is their mean level above bias. Subtracting one flat from the other removes dust shadows, vignetting and pixel-to-pixel sensitivity differences, leaving shot noise and read noise from two frames:

```
shot-noise variance = variance( flat1 − flat2 ) / 2 − R(ADU)²
```

Only the central half of the frame is used, and channels close to saturation are ignored. If you have no flats you can type the gain from the manufacturer's chart; every result then inherits the error of that number.

### Sky background

Two methods are offered.

- **Darkest tiles** (default). The frame is divided into a grid of up to 16 × 16 tiles. The median of each tile is taken, which ignores stars, and the 20th percentile of the tile medians is used. This lands on empty sky even when a nebula covers much of the frame.
- **Whole frame median.** Simple, and fine for sparse fields.

Then

```
S (e-) = ( background − bias level ) × gain
P      = S / exposure time
```

A small correction is applied because the median of a Poisson-distributed signal sits slightly below its mean, by roughly `S / (6 (S + R²))` electrons. It never exceeds a sixth of an electron.

### Noise check

As a sanity test, the script compares the measured scatter of the background (1.4826 × MAD, in electrons) with the prediction `√(R² + S)`. A ratio near 1.0 means bias level, gain and read noise agree with each other. A ratio well above 1 usually means nebulosity or gradients; a ratio that is off for every frame suggests a wrong gain.

### Moon and Sun

The Moon's illuminated fraction is computed from the frame's `DATE-OBS`. If the header (or the options) supply the site's latitude and longitude, the Moon's and Sun's altitude are added, and with `RA` / `DEC` keywords also the target's altitude and its angular distance from the Moon. The formulas are low-precision series good to a fraction of a degree.

## Using the results sensibly

- **Colour cameras with dual-band filters.** H-alpha and SII fall in the red channel, OIII and H-beta in green and blue. Each channel will ask for a different time. Pick the one you care about or settle in between.
- **Narrowband often asks for very long subs.** If your mount or conditions limit you, shoot shorter. At m = 3 you still get 87% of the ideal result.
- **A narrower filter is still worth it** even if you cannot reach your target m with it. It removes sky noise while keeping the nebula's signal, which gains more than the lost efficiency costs.
- **Bright skies give very short times.** Longer subs are fine as long as highlights are not clipped; you just stop gaining.
- **Keep a log.** The sky rate `P` is the number to record against Moon phase, Moon altitude and target altitude. Once you know `P` for a set of conditions you know your sub length.

## Further reading

- Charles Bracken, *The Deep-sky Imaging Primer*, third edition: chapter on setting exposure parameters, and the appendix deriving the stack efficiency.
- James Janesick, *Photon Transfer*, SPIE Press: the standard reference for measuring gain from flat pairs.
