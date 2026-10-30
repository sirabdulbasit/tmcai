# Vendored: @tmc/ai-integration v0.1

- **Source:** `@tmc/ai-integration` repository, commit **c0a6ebe** ("AI-Integration 0.1: the decoupled core and the ports"), directory `src/`.
- **Vendored:** 2026-10-30, DEF-365. Owner ruling the same day: *"adopt in Nexeo under integration — only adopt till mapping (further mapping should be as per Nexeo) and then Schedule and run"*.
- **Why vendored and not installed:** the production deploy does not run `npm install`, so no new package can be added. The framework's three runtime dependencies (`xlsx@0.18.5`, `mammoth@1.12.0`, `pdf-parse@2.4.5`) are already Nexeo dependencies at the same versions, so the code compiles and runs with no `package.json` change.

## Changes from the source

**None.** All 18 files under `src/` are copied byte-for-byte (`diff -r` against c0a6ebe `src/` is empty). Nexeo's `tsconfig.json` is *less* strict than the framework's (no `noUncheckedIndexedAccess`) and its default `lib` includes DOM, so no import path, type or strictness edit was needed. If one ever is, list it here: file, line, what changed, why.

Not copied: `package.json`, `tsconfig.json`, `docs/`, `README.md` and the source's `test/` folder. The tests that cover the modules Nexeo calls are copied (imports re-pointed only) into `server/tests/`:

| Nexeo test | Source test | Notes |
|---|---|---|
| `aiIntegrationRecipes.test.ts` | `test/integrationRecipes.test.ts` | whole file |
| `aiIntegrationPeriods.test.ts` | `test/integrationPeriods.test.ts` | whole file |
| `aiIntegrationFieldInventory.test.ts` | `test/integrationFieldMapping.test.ts` | whole file |
| `aiIntegrationSheetLink.test.ts` | `test/integrationSheetLink.test.ts` | only `parseSheetLink` / `isOnlySheetLink` / `nameFromDisposition`; the xlsx-download, workbook and token-read cases are not copied because Nexeo does not call them |

## Excel: xlsx@0.18.5 is NOT on any untrusted path

`xlsx@0.18.5` (the last SheetJS release on npm) has published CVEs: prototype pollution (CVE-2023-30533) and ReDoS (CVE-2024-22363). Several framework modules parse workbooks with it: `sources/workbook.ts` (`readWorkbook`, `sheetNamesOf`), `sources/sheetLink.ts` (`downloadSheetLink`, `tabForLink`, `readSheetWithToken`, `readDriveFileWithToken`), `sources/googleMicrosoftDrive.ts` (`downloadWorkbook`) and the `xlsx`/`xls`/`csv` branch of `sources/fileExtractor.ts`.

**In this change no upload and no Drive file reaches any of them.** Specifically:
- Google Sheets are still read as ONE tab's CSV export (Nexeo `sources/gsheetReader.ts`), parsed by Nexeo's own CSV parser.
- The API document reader calls `extractFile` only for DOCX and plain text, with a mime type Nexeo sets from its own kind check (the upload's mime type is never passed), so the framework's mime sniffing cannot pick its xlsx branch. PDF stays on Nexeo's page-capped path.
- `def365IntegrationFramework.test.ts` fails if any Nexeo source file imports one of the xlsx-reading functions above.

The modules are vendored whole (not trimmed) so that the copy stays identical to c0a6ebe. Importing them loads the `xlsx` module but parses nothing.

## What Nexeo uses, and how (DEF-365)

| Framework module | Nexeo use | Composed with |
|---|---|---|
| `mapping/recipes` (`validateRecipe`, `evaluateRecipe`) | KPI recipes: count / sum / ratio per month (`services/integrations/engine/kpiRecipe.ts`, `engine/planner.ts`) | Nexeo's cell rules run first (blank, non-number, ambiguous period, dimension); the framework sees only canonical numbers and `YYYY-MM` periods |
| `mapping/periods` (`recordPeriod` via recipes), `mapping/aggregate` | indirectly, through `evaluateRecipe` | — |
| `mapping/fieldInventory` (`discoverSourceFields`) | fill counts and the ≤12-values listing rule in `mapping/fieldInventory.ts` | Nexeo keeps sheet order, majority typing and its sample display |
| `sources/sheetLink` (`parseSheetLink`, `nameFromDisposition`) | second recogniser in `sources/sheetLink.ts`; Content-Disposition name in `gsheetReader.ts` | Nexeo's stricter link rules still decide |
| `sources/fileExtractor` (`extractFile`) | DOCX and text in `sources/docReader.ts` | Nexeo's byte cap, zip-declared-size cap, NUL check and 2M-char cap run first; Nexeo's redaction runs after |
| `net/outboundUrl` (`assertSafeOutboundUrl`) | first check on every hop of `sources/integrationFetch.ts` `guardedFetch`, loopback refused | Nexeo's DNS vetting + socket pinning still decide |
| `ports`, `ai/llmProvider` (types) | `services/integrations/framework/index.ts` adapter | — |

## What Nexeo does not use, and why

- `net/networkPolicy.applyOutboundNetworkPolicy`: it changes process-wide `dns`/`http`/`https` defaults for the whole Nexeo server, not just integrations.
- `sources/googleMicrosoftDrive` (OAuth consent, `accessTokenFor`, Drive listing and download): this is a per-integration Google/Microsoft consent. Nexeo reads a private sheet only through the tenant's designated account, resolved with userId null. A second account model would be a way around that rule. Drive Excel is also an xlsx path.
- `sources/sheetLink` download and token readers: these use the xlsx export or an xlsx round-trip (see above). They also follow redirects automatically, while Nexeo follows them by hand and allows Google hosts only.
- `jobs/proposalJobs`, `jobs/runJobs`: their keys are numeric (`integrationId: number, clientNumber: number`) and they have no "same inputs → same job, different inputs → 409" rule. Nexeo's proposal jobs (`mapping/proposalJobs.ts`) have that rule, and Nexeo run status is read from the run row so it survives a restart. Nexeo's are kept.
- `mapping/recipePrompts`, `ai/batching`: the goal-recipe prompt and goal-title recognition are written for people and goals (owner, team population, goal titles). Nexeo's proposer writes the KPI recipe itself, as one more KPI layout.
- `describeRecipe`: its wording is about people ("the person's rows"). Nexeo has its own plain-words sentence (`describeKpiRecipe`, client `describeRecipe`).
