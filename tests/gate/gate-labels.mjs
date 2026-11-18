const GATE_BLOCK_PREFIX =
  /^(?:Permission Gate(?: \([^)]*\))?|Anchor Guard|Token Economy|Loop Guard|Locate-first|Hygiene|Phase(?: \(PH1\))?|Commitlint|Commit Message|Toolchain|Search(?:Guard| Guard)?\s*(?=[:(])|Destructive|Bash cap|Output scrub)(?=[:\s(]|$)/i;

export const isGateBlockText = (text) => GATE_BLOCK_PREFIX.test(text.trimStart());

export const gateFamilyOf = (text) => {
  if (!isGateBlockText(text)) return null;
  const colon = text.indexOf(":");
  return (colon === -1 ? text : text.slice(0, colon)).trim();
};
