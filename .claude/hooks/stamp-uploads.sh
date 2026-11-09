#!/bin/bash
# UserPromptSubmit hook: any PDF attached to the user's message is checked and,
# if it is a 国際エアパケット送り状, stamped with the OSAKA KITA seal into stamped/.
# The result is printed so Claude sees it and can send the stamped PDF back.
# Never blocks the prompt.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
npx --no-install tsx src/shipping/stamp_uploads_hook.ts 2>/dev/null || true
exit 0
