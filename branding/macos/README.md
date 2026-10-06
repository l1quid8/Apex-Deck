# Apex Deck — 32-bit macOS image kit

The approved direction is the mint-green/cyan stepped diamond with a `>_` terminal prompt. “32-bit” describes the visual style; production PNGs use standard RGBA color and alpha.

## Included

- `ApexDeck-32bit.icns`: compiled macOS app icon.
- `AppIcon.iconset`: ten standard macOS icon slots, 16–1024 pixels.
- `Assets.xcassets`: AppIcon, eight image sets, and six named colors.
- `PNG`: app icons, transparent brand marks, stacked/horizontal logos for dark and light surfaces, isolated wordmarks, and menu bar templates.
- `Vectors`: editable SVG companions with outlined lettering and no font dependencies.
- `Masters/Approved-32bit-Logo.png`: unchanged copy of the selected 32-bit logo.
- `Masters/AppIcon-Generated.png`: selected app-icon adaptation with transparent rounded corners.
- `Preview.png`: visual overview.
- `Generation-Prompts.json`: prompt and method for the selected generated master.
- `Validation.json`: package checks and Xcode compilation result.

## Xcode

Merge the contents of `Assets.xcassets` into the application's existing asset catalog, avoiding duplicate asset names. Set the target's App Icons Source to `AppIcon`.

Use `ApexDeckMark` for the colored symbol. `ApexDeckLogo`, `ApexDeckHorizontal`, and `ApexDeckWordmark` contain white lettering for dark surfaces. Their `Light` variants contain dark lettering for light surfaces. Image sets include 1x, 2x, and 3x representations.

`ApexDeckMenuBar` is an 18-point monochrome template with transparent background and template rendering intent. If loading its PNG directly, set `NSImage.isTemplate = true` so macOS can adapt its color. For a status item, use the 18-point logical size rather than the raw Retina pixel size.

## Electron or other native packaging

Use `ApexDeck-32bit.icns` as the macOS bundle icon and `PNG/AppIcon-1024.png` as a high-resolution PNG source. This deliverable is an asset kit; application integration is a separate step.

## Artwork decisions

The app-icon master was created with the built-in image tool from the selected 32-bit reference. The original reference remains unchanged. Generated transparent cutouts had rough edges and were excluded. Transparent logo companions were rebuilt as clean native SVG shapes with pixel facets and outlined lettering; they are adaptations of the approved design, rather than exact raster extractions.

Icons at 16, 32, and 64 pixels use a simplified version of the same diamond and terminal prompt to preserve readability. Larger app icons use the selected generated master. The menu bar symbol uses a simple monochrome outline and prompt.

SVG sources can be imported into design tools. The kit uses the conventional asset catalog and ICNS workflow; it does not include a finished layered Icon Composer `.icon` document.

## Verification

The catalog was compiled with Apple's asset compiler for macOS with a 13.0 minimum deployment target. Icon-slot dimensions, PNG decoding, transparency, catalog references, the ICNS round trip, unchanged-reference hashes, and ZIP integrity were checked. This validates the asset package, not runtime display inside an application.

## Apple references

- [Standard macOS iconset filenames and sizes](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Finder.html)
- [App icon asset catalogs](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)
- [NSImage template rendering](https://developer.apple.com/documentation/appkit/nsimage/istemplate)
