const PORTABLE_PATH_PROFILES = new Set(['output', 'repo', 'archive']);
const WINDOWS_SAFE_PROFILES = new Set(['output', 'archive']);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const WINDOWS_SHORT_NAME = /~[1-9][0-9]*(?:\.|$)/iu;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const WINDOWS_INVALID_CHARACTER = /[<>"|?*]/u;

export class PortablePathError extends Error {
  constructor(message, {
    code,
    reason,
    value,
    profile,
    segment,
    segmentIndex,
    character,
    index,
    conflictIndex,
    conflictValue,
    collisionKind,
    semantics,
    pathPart,
    conflictPathPart,
    utf8Bytes,
    utf16CodeUnits,
    limit,
  } = {}) {
    super(message);
    this.name = 'PortablePathError';
    this.code = code;
    this.reason = reason;
    this.value = value;
    this.profile = profile;
    if (segment !== undefined) this.segment = segment;
    if (segmentIndex !== undefined) this.segmentIndex = segmentIndex;
    if (character !== undefined) this.character = character;
    if (index !== undefined) this.index = index;
    if (conflictIndex !== undefined) this.conflictIndex = conflictIndex;
    if (conflictValue !== undefined) this.conflictValue = conflictValue;
    if (collisionKind !== undefined) this.collisionKind = collisionKind;
    if (semantics !== undefined) this.semantics = semantics;
    if (pathPart !== undefined) this.pathPart = pathPart;
    if (conflictPathPart !== undefined) this.conflictPathPart = conflictPathPart;
    if (utf8Bytes !== undefined) this.utf8Bytes = utf8Bytes;
    if (utf16CodeUnits !== undefined) this.utf16CodeUnits = utf16CodeUnits;
    if (limit !== undefined) this.limit = limit;
  }
}

function pathError(value, profile, reason, message, details = {}) {
  return new PortablePathError(message, {
    code: `portable-path/${reason}`,
    reason,
    value,
    profile,
    ...details,
  });
}

function assertProfile(profile) {
  if (PORTABLE_PATH_PROFILES.has(profile)) return;
  throw pathError(
    undefined,
    profile,
    'profile',
    `Portable path profile must be one of: ${[...PORTABLE_PATH_PROFILES].join(', ')}.`,
  );
}

export function validatePortablePath(value, options = {}) {
  const profile = options?.profile;
  assertProfile(profile);

  if (typeof value !== 'string') {
    throw pathError(value, profile, 'type', 'Portable path must be a string.');
  }
  if (value.length === 0) {
    throw pathError(value, profile, 'empty', 'Portable path must not be empty.');
  }
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    throw pathError(value, profile, 'absolute', 'Portable path must be relative.');
  }
  if (/^[A-Za-z]:/u.test(value)) {
    throw pathError(
      value,
      profile,
      'drive-relative',
      'Portable path must not use a drive-relative Windows path.',
    );
  }
  if (URI_SCHEME.test(value)) {
    throw pathError(value, profile, 'uri', 'Portable path must not be a URI.');
  }
  if (value.includes('\\')) {
    throw pathError(
      value,
      profile,
      'backslash',
      'Portable path must use forward slashes as separators.',
    );
  }

  const segments = value.split('/');
  for (const [segmentIndex, segment] of segments.entries()) {
    const segmentDetails = { segment, segmentIndex };
    if (segment.length === 0) {
      throw pathError(
        value,
        profile,
        'empty-segment',
        'Portable path must not contain empty segments.',
        segmentDetails,
      );
    }
    if (segment === '.' || segment === '..') {
      throw pathError(
        value,
        profile,
        'dot-segment',
        'Portable path must not contain dot segments.',
        segmentDetails,
      );
    }
    const controlMatch = segment.match(CONTROL_CHARACTER);
    if (controlMatch) {
      throw pathError(
        value,
        profile,
        'control',
        'Portable path must not contain control characters.',
        { ...segmentDetails, character: controlMatch[0] },
      );
    }
    const surrogateMatch = segment.match(/[\uD800-\uDFFF]/u);
    if (surrogateMatch) {
      throw pathError(
        value,
        profile,
        'unpaired-surrogate',
        'Portable path must not contain unpaired UTF-16 surrogates.',
        { ...segmentDetails, character: surrogateMatch[0] },
      );
    }

    if (!WINDOWS_SAFE_PROFILES.has(profile)) continue;
    if (segment.includes(':')) {
      throw pathError(
        value,
        profile,
        'windows-ads',
        'Portable path must not select a Windows alternate data stream.',
        { ...segmentDetails, character: ':' },
      );
    }
    const invalidMatch = segment.match(WINDOWS_INVALID_CHARACTER);
    if (invalidMatch) {
      throw pathError(
        value,
        profile,
        'windows-invalid-character',
        'Portable path contains a character that is invalid in Windows file names.',
        { ...segmentDetails, character: invalidMatch[0] },
      );
    }
    if (/[. ]$/u.test(segment)) {
      throw pathError(
        value,
        profile,
        'windows-trailing-dot-space',
        'Portable path segments must not end with a dot or space.',
        segmentDetails,
      );
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw pathError(
        value,
        profile,
        'windows-reserved-name',
        'Portable path must not use a reserved Windows device name.',
        segmentDetails,
      );
    }
    if (WINDOWS_SHORT_NAME.test(segment)) {
      throw pathError(
        value,
        profile,
        'windows-short-name',
        'Portable path must not use a Windows 8.3 short-name shape.',
        segmentDetails,
      );
    }
    const utf8Bytes = Buffer.byteLength(segment, 'utf8');
    const utf16CodeUnits = segment.length;
    if (utf8Bytes > 255 || utf16CodeUnits > 255) {
      throw pathError(
        value,
        profile,
        'component-too-long',
        'Portable path segments must fit both UTF-8 and UTF-16 filesystem component limits.',
        {
          ...segmentDetails,
          utf8Bytes,
          utf16CodeUnits,
          limit: 255,
        },
      );
    }
  }

  return value;
}

function collisionError(values, profile, index, conflictIndex, reason, details = {}) {
  return new PortablePathError(
    `Portable paths at indexes ${conflictIndex} and ${index} collide under portable filesystem semantics.`,
    {
      code: 'portable-path/collision',
      reason,
      value: values[index],
      profile,
      index,
      conflictIndex,
      conflictValue: values[conflictIndex],
      ...details,
    },
  );
}
