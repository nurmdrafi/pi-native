# Evidence gathering in multi-component systems

Phase 1, step 4 detail. Read when system has multiple components (CI → build → signing, API → service → database) or intermittent external-API failure.

**BEFORE proposing fixes, instrument:**
```
For EACH component boundary:
  - Log data entering component
  - Log data exiting component
  - Verify environment/config propagation
  - Check state at each layer

Run once → evidence shows WHERE it breaks
→ analyze evidence, identify failing component
→ investigate that component
```

Example (multi-layer):
```bash
# Layer 1: Workflow
# Identity defined where it should be? (presence only, never the value)
echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

# Layer 2: Build script
# Did it survive export into the build step? (presence only, never the value)
if [ -n "${IDENTITY:-}" ]; then echo "IDENTITY: SET"; else echo "IDENTITY: UNSET"; fi

# Layer 3: Signing script
# Credential store reachable and holding a signing identity? Count only,
# never print identities or store listings:
security find-identity -v -p codesigning 2>/dev/null | grep -c . || echo "0 valid signing identities"

# Layer 4: Actual signing
codesign --sign "$IDENTITY" --verbose=4 "$APP"
```

Reveals which layer fails (secrets → workflow ✓, workflow → build ✗).

Intermittent external-API failure that "works in my tool": inspect response headers for throttle counters (`x-ratelimit-limit`, `x-ratelimit-remaining`, `retry-after`). Per-IP rate limits fire only from production caller — server proxying all users through one egress IP trips cap at traffic peaks; Postman/curl from dev machine = different IP, stays under. Confirm: hammer endpoint past stated limit from failing caller's network, watch responses flip to 429 exactly at cap. Catch-all rethrowing one generic message hides which class fired — read status before trusting user-facing message.
