// Assembles every permission-gate case module. Order is stable: rule modules
// (alphabetical), then scenes. Add a module by re-running the tree once — the
// runner only needs this list.
import { cases as m0 } from "./rules/commitMessageLint.mjs";
import { cases as m1 } from "./rules/destructiveConfirm.mjs";
import { cases as mES } from "./rules/errorSwallow.mjs";
import { cases as mRB } from "./rules/readerBypass.mjs";
import { cases as mVC } from "./rules/viewCredit.mjs";
import { cases as m2 } from "./rules/failureLoopGuard.mjs";
import { cases as m3 } from "./rules/largeReadGuard.mjs";
import { cases as mLF } from "./rules/locateFused.mjs";
import { cases as m4 } from "./rules/loopGuard.mjs";
import { cases as m5 } from "./rules/nativeBashFirst.mjs";
import { cases as m6 } from "./rules/nativeReadFirst.mjs";
import { cases as m7 } from "./rules/outputCap.mjs";
import { cases as m8 } from "./rules/phaseNudge.mjs";
import { cases as m9 } from "./rules/reReadConsume.mjs";
import { cases as m10 } from "./rules/reReadGuard.mjs";
import { cases as m11 } from "./rules/readOutputCap.mjs";
import { cases as m12 } from "./rules/reblockEscalation.mjs";
import { cases as m13 } from "./rules/rerunGuard.mjs";
import { cases as m14 } from "./rules/searchScope.mjs";
import { cases as m15 } from "./rules/editAnchorGuard/anchor-guard.mjs";
import { cases as m16 } from "./rules/editAnchorGuard/compaction-gap.mjs";
import { cases as m17 } from "./rules/editAnchorGuard/validation-anchors.mjs";
import { cases as m18 } from "./rules/editAnchorGuard/validation-binding.mjs";
import { cases as m19 } from "./rules/editAnchorGuard/validation-freshness.mjs";
import { cases as m20 } from "./rules/editAnchorGuard/validation-protected-policy.mjs";
import { cases as m21 } from "./scenes/interplay.mjs";
import { cases as m22 } from "./scenes/normalization.mjs";
import { cases as m23 } from "./scenes/security-canary.mjs";
import { cases as m24 } from "./scenes/security-failure-path.mjs";
import { cases as m25 } from "./scenes/security-protected-paths.mjs";
import { cases as m26 } from "./scenes/security-toctou.mjs";

const modules = [m0, m1, mES, mRB, mVC, m2, m3, mLF, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15, m16, m17, m18, m19, m20, m21, m22, m23, m24, m25, m26];

export const cases = modules.flat();
