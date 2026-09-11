# Prepare a release and archive

This guide connects a reviewed COMIC revision, its figure reproduction materials and the
Aperture Neuro manuscript. It is a preparation guide: it does not identify a published
alpha release or an existing Zenodo deposit.

## Review and record the software

1. Choose the revision after the Python, JavaScript and browser checks have passed. Inspect
   the rendered examples, including medial anatomy, native surface and parcel inputs,
   colour bars and browser-to-CLI replay.
2. Record the exact commit and the environment used for the figures. Regenerate the
   manuscript figures from that revision, then update their provenance and checksums.
3. Agree the release identifier. The present package metadata says `1.0.0`; the planned
   `0.1 alpha` needs a deliberate, consistent identifier in package metadata, citation
   metadata, the release tag, manuscript and archive. Do not describe existing output as
   an alpha release merely by changing its caption.
4. Write release notes around tested behavior and remaining limitations. Identify any
   changes that can alter earlier output, such as corrected voxel coordinates or revised
   recipe replay.

The test commands are in [CONTRIBUTING.md](../CONTRIBUTING.md). The supported workflow and
its scientific limits are described in [METHODS.md](../METHODS.md).

## Assemble the reproduction materials

Keep the following together:

- original and prepared inputs, with source attribution and any redistribution terms;
- named parcel values and the independently verified atlas ordering;
- saved recipes, exact input order, processing choices and figure assembly scripts;
- the source revision, environment record and checksums;
- final images and their legends, plus the manuscript source and reading copy.

Check that commands use paths relative to the package and that the package can be unpacked
and reproduced in a clean environment. Resolve author information, funding and the parcel
field's provenance before treating the manuscript as final.

## Create the release and Zenodo record

After the review is complete, use the agreed tag for the software release and archive that
release with its reproduction materials. Review the archive contents and metadata before
publishing the record: title, authors, ORCIDs, licence, software version, description and
related identifiers should describe the same release.

Use the permanent identifier actually assigned to the archived release. Add it to the
manuscript and citation metadata; keep the exact source commit as well. Do not substitute
a planned DOI or the changing hosted viewer URL for an immutable source record.

## Prepare the Aperture Neuro submission

Confirm the current author guidance at the time of submission. Review the manuscript,
figures, declarations, AI disclosure and cover letter together, and confirm that every
code, data and archive link resolves. The paper should report the release and figures that
were actually checked.

Release publication, archive publication and journal submission are separate actions.
Record the resulting identifiers and dates after each has occurred.
