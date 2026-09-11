# Third-party notices

The MIT licence in [LICENSE](LICENSE) covers Comic's original source code. The repository
also contains third-party software and data. Those materials remain under the terms of
their respective copyright holders and are not relicensed by Comic.

This file records the provenance known for the assets distributed in the repository. It
is an attribution and packaging record, not legal advice.

## Anatomical template assets

### FreeSurfer fsaverage

The cortical surfaces, cortical sampling arrays, segmentation-derived classifications and
internal anatomical meshes under `comic/web/data/` are derived from the FreeSurfer
fsaverage distribution.

- Source: [FreeSurfer](https://surfer.nmr.mgh.harvard.edu/)
- Terms: [FreeSurfer Software License Agreement, version 1.0](https://surfer.nmr.mgh.harvard.edu/fswiki/FreeSurferSoftwareLicense)
- Copyright: The General Hospital Corporation, Boston, Massachusetts, USA

These assets are group-template anatomy and are not subject-specific reconstructions.

### ICBM 152 nonlinear atlas 2009c

`comic/web/data/anat_uint8.bin.gz` is derived from the 1 mm ICBM 2009c nonlinear
asymmetric T1 template distributed with AFNI. Comic stores a quantised, pial-masked form
for rendering exposed cut faces.

- Source: [ICBM 152 nonlinear atlases, 2009](https://nist.mni.mcgill.ca/icbm-152-nonlinear-atlases-2009/)
- Copyright: 1993-2004 Louis Collins, McConnell Brain Imaging Centre, Montreal
  Neurological Institute, McGill University
- Terms: use, copying, modification and distribution are permitted without fee provided
  that the upstream copyright notice appears in copies; the material is provided without
  warranty.

## Atlas and demonstration data

### Schaefer parcellations

The bundled Schaefer 2018 fsaverage parcellations under
`comic/web/data/parcels/schaefer*` come from the Computational Brain Imaging Group (CBIG),
pinned to `v0.14.3-Update_Yeo2011_Schaefer2018_labelname`.

- Source: [ThomasYeoLab/CBIG](https://github.com/ThomasYeoLab/CBIG)
- Licence: MIT
- Citation: Schaefer et al. (2018), *Cerebral Cortex*, 28, 3095-3114

FreeSurfer, Yeo and HCP-MMP atlases that have different terms are fetched from a user's
own installation and are deliberately excluded from this repository.

### Neurosynth demonstration maps

The four demonstration NIfTI files in `comic/web/data/defaults/` are Neurosynth
association maps for faces, addiction, default network and language.

- Source: [Neurosynth](https://neurosynth.org/)
- Data terms: [Open Database License](https://github.com/neurosynth/neurosynth-data)
- Citation: Yarkoni et al. (2011), *Nature Methods*, 8, 665-670

## Vendored browser software and fonts

### Three.js

The Three.js r170 module and selected loaders under `comic/web/vendor/three/0.170.0/`
are distributed under the MIT licence.

- Source: [mrdoob/three.js](https://github.com/mrdoob/three.js)
- Copyright: 2010-2024 Three.js authors

### gifenc

`comic/web/vendor/gifenc/gifenc.esm.js` is from gifenc and is distributed under the MIT
licence.

- Source: [mattdesl/gifenc](https://github.com/mattdesl/gifenc)
- Copyright: 2017 Matt DesLauriers

### Computer Modern Unicode

`comic/web/vendor/cm-fonts/cmunrm.woff` is the CMU Serif Roman web font obtained from
`aaaakshat/cm-web-fonts`. Computer Modern Unicode is distributed under the SIL Open Font
License 1.1.

- Source: [aaaakshat/cm-web-fonts](https://github.com/aaaakshat/cm-web-fonts)
- Upstream project: [Computer Modern Unicode](https://cm-unicode.sourceforge.io/)
- Copyright: 2003-2009 Andrey V. Panov
- Licence: [SIL Open Font License 1.1](https://openfontlicense.org/)

### NiBabel browser wheel

`comic/web/data/nibabel-5.4.2-py3-none-any.whl` is an unmodified NiBabel wheel used by
the Pyodide browser pipeline. NiBabel is MIT licensed; the wheel contains its full
copyright and third-party notices.

- Source: [nipy/nibabel](https://github.com/nipy/nibabel)
- Licence: MIT, with additional notices embedded in the wheel

### Colormap lookup tables

`comic/web/data/colormaps.json` contains sampled lookup tables for continuous Matplotlib
colormaps, exported through the `cmap` Python package. The tables retain the provenance
and terms of their upstream collections.

- Source library: [pyapp-kit/cmap](https://github.com/pyapp-kit/cmap)
- Primary collection: [Matplotlib colormaps](https://matplotlib.org/stable/users/explain/colors/colormaps.html)
- Matplotlib licence: [Matplotlib licence](https://matplotlib.org/stable/project/license.html)

## MIT licence text for vendored MIT components

Permission is hereby granted, free of charge, to any person obtaining a copy of the
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
