# Live test record · September 10, 2026

[English](LIVE_TEST.en.md) · [简体中文](LIVE_TEST.md) · [Project overview](../README.md)

## Real WoS collection

The standalone program executed all nine search expressions from the precise September 4, 2026 strategy. Each fully expanded expression matched the previously saved configuration character for character. No manually downloaded files were substituted, and neither userscript request replay nor TXT parsing was used.

The complete export used Playwright 1.63.0 with its Chromium 153.0.8010.12 browser. Earlier downloads with the locally installed Chrome 152.0.7977.83 encountered browser crashes. Browser or service failures stopped processing and preserved completed files; resume continued the task without marking failed batches complete. The work also encountered server errors, unavailable custom-field menus, and zero-result searches.

| Search set | Results | Native batches |
| :--- | ---: | :--- |
| P1 | 693 | 1 |
| P2 | 41 | 1 |
| P3 | 128 | 1 |
| P4 | 11 | 1 |
| P5 | 15 | 1 |
| P6 | 0 | 0 |
| P7 | 0 | 0 |
| P8 | 85 | 1 |
| Related-alloy comparison | 1,294 | 2: records 1–1000 and 1001–1294 |

- **8 native XLS batches**, containing **2,267 rows**.
- **2,103 unique UTs** after removing **164 cross-set duplicates**.
- **72 native fields**, with the same names and order as the previously checked native Excel exports.
- The unique-UT set matched the previous native-field merged workbook: no added or missing UTs.
- **Zero conflicting fields** for duplicate UTs and **zero CR/LF cells** in this run. No line-break cleaning was performed.
- Each downloaded batch was checked for its actual format, row count, fields, and UTs. The merged workbook is a derived native-field workbook, not a single website download.

## Live interruption and resume

A separate test used the same P4 expression, returning 11 records, with a batch size of six. After records 1–6 had been downloaded and saved, the process received Ctrl+C. Restarting with `--resume` downloaded only records 7–11.

The final result contained 11 records in two native batches. The first batch's modification time was unchanged, confirming that it was not downloaded again or overwritten.

## Local tests

Six targeted tests cover configuration, result counts, incomplete fields, invalid downloads, missing or overlapping batches, actual browser controls and downloads, field reselection, merging, saved progress, and completed-run reuse. Local fixture tests and live WoS tests are distinct forms of verification.

Only this aggregate record is included in the repository. Paper metadata, native download batches, login profiles, and local diagnostic logs are not uploaded.
