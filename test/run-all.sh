#!/bin/bash
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
RESULTS=()

TESTS=(
  "01-typescript-compilation.ts|TypeScript compilation"
  "02-file-architecture.ts|File architecture"
  "03-crypto-integrity.ts|Crypto integrity"
  "04-spec-parser.ts|Spec parser"
  "05-criteria-normalization.ts|Criteria normalization"
  "06-template-validation.ts|Template validation"
  "07-verify-tampering.ts|Verify tampering detect"
  "08-cli-commands.ts|CLI commands"
  "09-readme-quality.ts|README quality"
  "10-e2e-receipt-flow.ts|E2E receipt flow"
)

echo ""
echo "Running Lockstep self-verification tests..."
echo ""

IDX=1
for entry in "${TESTS[@]}"; do
  IFS='|' read -r file label <<< "$entry"
  echo "--- [$IDX/10] $label ---"
  if npx tsx "test/$file" 2>&1; then
    RESULTS+=("[$IDX/10] $label    ✅ PASS")
    ((PASS++))
  else
    RESULTS+=("[$IDX/10] $label    ❌ FAIL")
    ((FAIL++))
  fi
  echo ""
  ((IDX++))
done

echo "=== LOCKSTEP SELF-VERIFICATION RESULTS ==="
for r in "${RESULTS[@]}"; do
  echo "$r"
done
echo "==========================================="
echo "TOTAL: $PASS/10 passed"
if [ $FAIL -gt 0 ]; then
  echo "❌ $FAIL test(s) failed"
  exit 1
else
  echo "✅ All tests passed!"
  exit 0
fi
