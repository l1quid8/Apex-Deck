# ApexAgent task card mockup

Design only, with sample data and simulated actions. No backend connections.

Open `index.html` for Mac, or `index.html?device=phone` for iPhone. Add `&state=done` to the phone URL for completed tasks (Mac: `?state=done`).

One card per task stays at its original position in the conversation. The card shows goal, host, current status, latest outcome and next action. Commands and earlier checks expand under Details & history. Pending approvals expose command, folder and machine without expansion. Ordinary chat stays as messages. Approve, Decline and Stop simulate updates without adding duplicate cards; no real actions run.

Screenshots: `screenshots/{mac,phone}-{approval,done}.png`.

Regenerate from the repository root:

```sh
node_modules/.bin/electron docs/mockups/apex-agent-task-cards/capture.cjs
```

Captured at Mac 1280×860 and iPhone 393×852. The iPhone images are browser mockups, not captures from a physical phone.
