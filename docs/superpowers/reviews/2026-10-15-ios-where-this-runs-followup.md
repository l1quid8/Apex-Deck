# iOS “Where this runs” sheet follow-up

The location sheet now uses a centered title with a circular close target, grouped Project and Machine choices, clearer online/offline metadata, and a subtle accent treatment for the current machine. Lock guidance follows the choices, then a short note clarifies that files stay on each machine. The unavailable “work without a project” placeholder was removed rather than promoted as an action. Existing project and machine selection callbacks and offline-row behavior remain in place.

Validation: `npx tsc --noEmit`, focused destination/composer tests (18 passing), `node scripts/build-phone.mjs`, and `git diff --check` passed. Native simulator appearance remains for the parent’s final build and inspection.
