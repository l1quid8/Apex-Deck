# iOS composer destination row

The composer now presents one “Project & machine” destination row with the active project and machine beneath it. Selecting the row opens “Where this runs,” where project switching remains available. The fixture verifies the single row, absence of separate shortcuts, and exactly one location callback.

Validation: TypeScript, the focused phone/composer tests, and the phone asset build passed.
Parent verification: TypeScript and all 12 focused tests passed independently. The signed simulator build installed successfully, strict codesign verification passed, and all 13 bundled web asset hashes matched `dist-phone`. Native inspection confirmed one combined row with both values, opening Where this runs correctly. The expanded composer remains open in Frost. Screenshot: `/Users/tylercaldwell/Downloads/apex-deck/release/ios/composer-panel-preview/destination-combined.png`. No merge, push, or TestFlight upload occurred.
