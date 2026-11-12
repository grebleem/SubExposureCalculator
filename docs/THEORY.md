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

## The suggested sub-exposure

The table gives a time for every channel and every target multiple. The script also condenses this into one suggestion per filter.

- **Which multiple.** The suggestion aims for the middle one of your target multiples: 5 with the default `3, 5, 10` (the lower middle if you enter an even number of them). The lowest and highest multiples give the limits around it. Below the first you start to lose noticeably; above the last there is almost nothing left to gain.
- **Two read noise figures, so a range.** The time goes with `R²`, and the script measures two values of `R` (see *Read noise* below). They can differ by a quarter, which changes the time by more than half. The suggestion is therefore worked out twice. The short end uses the read noise of a typical pixel, the long end the RMS of all pixels, noisy ones included. Which one applies depends on how you image. Without dithering, each point of the sky stays on one pixel, and most pixels are typical ones. With dithering, each point is recorded by many different pixels, so the stack sees their average variance, which is what the RMS figure measures; pixel rejection then takes a little of that back. A stack lands between the two ends, nearer the long one if you dither. When both ends round to the same sub length, a single time is shown.
- **Colour cameras.** A one-shot-colour camera takes a single exposure for red, green and blue. Each channel has its own sky rate `P` and its own read noise `R`, so each reaches a given m at a different time. The suggestion uses the channel with the smallest `P / R²`, the one whose sky builds up most slowly against its read noise. When that channel reaches the target, the other two are above it. The results name the channel and list where each one lands.
- **Rounding.** A calculated time is rounded to a common sub length (60, 90, 120, 180, 300 s and so on): the first one that is not more than 5% shorter. With the default target of 5, being 5% short costs under half a percent of efficiency. The calculated times are shown next to the rounded ones.
- **Limits.** The "still worthwhile" limit is the lowest multiple with the typical-pixel read noise; the "nothing left to gain" limit is the highest multiple with the all-pixel read noise.

The suggestion is derived from your frames and your chosen multiple. It is not an optimum, because there is none, and it holds only for the sky as it was when the frames were taken.

If the all-pixel read noise is more than twice the typical-pixel value, the script warns. A few extreme pixels or cosmic ray hits in the bias frames can inflate the unclipped figure, and the long end of the range is then too long.

### The graph

The Graph window plots efficiency `√(m / (m + 1))` against sub length on a logarithmic time axis. Solid curves, one per channel, use the read noise of a typical pixel. When the suggestion is a range, a dashed curve shows the slowest channel with the read noise of all pixels. The gold band is the suggested range, the wider grey band runs between the two limits described above, a dotted line marks the exposure of the frames you measured, and horizontal dashed lines mark the efficiency belonging to each target multiple. A table beside the graph lists each channel's efficiency at both ends. The curves make the diminishing returns visible: they rise steeply at first and are nearly flat by the right-hand side.

## How the script measures each quantity

All statistics are taken per channel. For a colour sensor the red, green and blue pixels of the Bayer mosaic are separated by position, with no interpolation; the two green positions are pooled.

### Two stages

Bias level, read noise and conversion gain are properties of the camera at one gain, offset and binning. The sky rate is a property of one night, one filter and one part of the sky. The script therefore works in two stages.

1. **Camera.** Measured from bias frames and flat frames (or a typed gain) and saved as an entry in the camera list. The list is kept by PixInsight and survives closing the program. An entry can be exported to a file and imported elsewhere.
2. **Light frames.** Measured against the camera chosen from the list. Only the light frames are read.

One entry stands for one camera at one gain, offset and binning: read noise and gain are different numbers at a different setting, so each setting you use needs its own entry. The results name the camera, and state when and from how many frames it was measured, so it is always clear which camera data a sky rate rests on. The script compares the `GAIN` and `OFFSET` keywords of every light frame with those of the camera's bias frames and warns when they differ.

### Many frames

Two bias frames and two flats are enough, but more frames make the measurement firmer and expose bad frames.

- **Bias frames** are used two at a time, in the order given. Each pair gives a bias level and the two read noise figures, and the median over the pairs is kept. A median is used rather than a mean because one disturbed pair must not move the result: a single cosmic ray hit can inflate the unclipped read noise of its pair many times over, and the median over three or more pairs ignores it. With an odd number of frames the last one is left out.
- **Flat frames** are paired with their neighbour in the list when both were taken through the same filter and their brightness agrees within 2%. A frame without such a partner is left out and counted. Each pair gives a gain, and the median over all usable pairs and channels is kept.
- **Filters.** The conversion gain is a property of the camera's electronics, not of the light that reaches it, so flats through any mix of filters measure the same number and all pairs count towards one figure. The script still reports the gain per filter. If they differ by more than 3% it warns, because that points to flats that are too bright, too faint or uneven through one filter.
- **Agreement.** With several pairs the results show the scatter between them (standard deviation as a percentage) for read noise and for gain. A scatter well under a percent means the frames tell one story.

### Bit depth

Cameras with a 12 or 14 bit converter usually deliver their values shifted up to the 16 bit range, so a 12 bit camera only produces multiples of 16 and a 14 bit camera multiples of 4. Medians taken on such values can only land on a multiple of the step, which would put the bias level and the background off by up to half a step each. For a faint sky that is an error of several percent in the sky rate.

The script therefore looks at the two bias frames, finds the largest power of two that divides every pixel value, and brings all frames back to the camera's own steps before taking any statistics. ADU values in the results are converted back, so they match what you see in the file. The results state the bit depth that was found and give the gain both per file ADU and per camera ADU. A gain you type is taken per ADU as stored in the file.

Two limits follow from this method:

- Files that hold 12 or 14 bit values unscaled (0 to 4095 or 16383), as some DSLR conversions do, look like ordinary data and are measured correctly. Their true full scale is not known, though, so saturated flats and clipped stars are not flagged.
- The measured read noise includes the quantisation noise of the converter, one twelfth of a camera ADU squared. That is the noise actually present in each frame, so it is the right figure for this purpose, but it can be a little higher than a manufacturer's value. When the read noise is below half a camera ADU, which happens at the lowest gain settings of some 12 bit cameras, it cannot be measured reliably from bias frames and the script says so.

### Bias level

The median of the two bias frames. Cameras add this pedestal (the "offset") so that noise never produces negative values. It must be subtracted before ADU can be converted to electrons.

### Read noise

Within a pair, one bias frame is subtracted from the other, pixel by pixel. Anything fixed (the pedestal, column patterns, warm pixels) cancels. What remains is random noise from two frames, so

```
R (ADU) = standard deviation( bias1 − bias2 ) / √2
R (e-)  = R (ADU) × gain
```

Two figures are reported. The *typical pixel* value is sigma-clipped at 5 sigma, so cosmic ray hits and the small share of noisy pixels found on every CMOS sensor do not inflate it; this is the value used for the table. The *RMS of all pixels* is the plain, unclipped figure and is closer to what manufacturers publish. The effective read noise of a stack lies between them, which is why the suggested sub-exposure is worked out with both. A master bias cannot be used: stacking averages away the very noise being measured.

### Conversion gain (e-/ADU)

Photon arrival follows Poisson statistics: measured in electrons, the variance of a signal equals the signal. In ADU, with `g` electrons per ADU, a signal of `L` ADU therefore has a shot-noise variance of `L / g`. Rearranged:

```
g = L / (shot-noise variance in ADU)
```

A pair of flats gives both terms. `L` is their mean level above bias. Subtracting one flat from the other removes dust shadows, vignetting and pixel-to-pixel sensitivity differences, leaving shot noise and read noise from two frames:

```
shot-noise variance = variance( flat1 − flat2 ) / 2 − R(ADU)²
```

Only the central half of the frame is used, and channels close to saturation are ignored. If you have no flats you can type the gain from the manufacturer's chart; every result then inherits the error of that number.

### Sky background

Two methods are offered.

- **Darkest tiles** (default). The frame is divided into a grid of up to 16 × 16 tiles. The median of each tile is taken, which ignores stars, and the 20th percentile of the tile medians is used. This lands on empty sky even when a nebula covers much of the frame.
- **Whole frame median.** Simple, and fine for sparse fields.
- **Preview (your own region).** You draw a preview on an open raw light frame, on a patch of sky you judge to be empty, and choose it in the script. The median of that rectangle, per channel, is the background. The same rectangle is used in every light frame in the list, so the frames should share the same framing; dithering by a few pixels does not matter. The median ignores a few faint stars, but keep bright stars out and make the rectangle at least 100 × 100 pixels, or the result gets noisy. The script warns below that size. Stay away from the corners and edges: a raw frame is darker there because of vignetting, so a patch near the edge reads a lower sky than the middle of the frame really has. The same vignetting pulls the *Darkest tiles* estimate a little towards the edges too.

The **Map** window shows what these methods work with. It draws a light frame cut into the same tiles, each with its median in ADU above the bias level, shaded from the darkest tile to the brightest by rank, so one very bright tile cannot flatten the rest. With *Darkest tiles* the tile or the two tiles between which the 20th percentile fell are outlined. With *Preview* your rectangle is drawn at its place in the frame, and the value the tiles would have given is shown next to yours. The map makes three things visible that a single number hides: where the nebula lies, how much the frame darkens towards its corners, and whether the patch behind the reading is the kind of sky you had in mind.

Then

```
S (e-) = ( background − bias level ) × gain
P      = S / exposure time
```

A small correction is applied because the median of a Poisson-distributed signal sits slightly below its mean, by roughly `S / (6 (S + R²))` electrons. It never exceeds a sixth of an electron.

### Noise check

As a sanity test, the script compares the measured scatter of the background (1.4826 × MAD, in electrons) with the prediction `√(R² + S)`. A ratio near 1.0 means bias level, gain and read noise agree with each other. A ratio well above 1 usually means nebulosity or gradients; a ratio that is off for every frame suggests a wrong gain. The scatter is taken over the whole frame, which is why a nebula that fills the frame raises the ratio even when the background itself was found correctly. With your own region, the scatter is taken inside that region only, so the ratio tells you whether the patch you chose behaves like plain sky.

### Moon and Sun

The Moon's illuminated fraction is computed from the frame's `DATE-OBS`. If the header (or the options) supply the site's latitude and longitude, the Moon's and Sun's altitude are added, and with `RA` / `DEC` keywords also the target's altitude and its angular distance from the Moon. The formulas are low-precision series good to a fraction of a degree.

## Using the results sensibly

- **Colour cameras with dual-band filters.** H-alpha and SII fall in the red channel, OIII and H-beta in green and blue. The channels then ask for very different times, and the suggestion follows the slowest one, which can be long. If it is more than your mount or sky allows, pick the channel you care about or settle in between.
- **Narrowband often asks for very long subs.** If your mount or conditions limit you, shoot shorter. At m = 3 you still get 87% of the ideal result.
- **A narrower filter is still worth it** even if you cannot reach your target m with it. It removes sky noise while keeping the nebula's signal, which gains more than the lost efficiency costs.
- **Bright skies give very short times.** Longer subs are fine as long as highlights are not clipped; you just stop gaining.
- **Keep a log.** The sky rate `P` is the number to record against Moon phase, Moon altitude and target altitude. Once you know `P` for a set of conditions you know your sub length.

## Further reading

- Charles Bracken, *The Deep-sky Imaging Primer*, third edition: chapter on setting exposure parameters, and the appendix deriving the stack efficiency.
- James Janesick, *Photon Transfer*, SPIE Press: the standard reference for measuring gain from flat pairs.
