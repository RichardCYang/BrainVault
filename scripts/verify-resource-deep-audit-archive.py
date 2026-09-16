#!/usr/bin/env python3
"""Read-only ZIP verification. Does not extract or invoke Git.
Usage: python scripts/verify-resource-deep-audit-archive.py ORIGINAL.zip FIXED.zip --output result.json
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
import zipfile

EXPECTED_ORIGINAL_SHA256 = '1a017a8c791d615b59b9836b9b8ff1a95df31abef239def164efc6a6d4816f17'
EXPECTED_CHANGES = {'src/lib/accordion.ts', 'public/ai-chat-block.js', 'src/lib/ai-chat.ts', 'public/accordion-block.js', 'public/treeview-block.js', 'public/database-block.js', 'public/timetable-block.js', 'public/gantt-block.js'}
METADATA = ('date_time', 'compress_type', 'comment', 'extra', 'create_system', 'create_version',
            'extract_version', 'reserved', 'flag_bits', 'volume', 'internal_attr', 'external_attr',
            'CRC', 'compress_size', 'file_size')

def sha(value):
    return hashlib.sha256(value).hexdigest()

def file_sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def is_git(name):
    return name.rstrip('/') == '.git' or name.startswith('.git/')

def local_record(archive, info):
    # The fixed-size ZIP local header is followed by filename, extra and payload.
    # Preserve and compare any data descriptor too, up to the next local record.
    end = min((i.header_offset for i in archive.infolist() if i.header_offset > info.header_offset), default=archive.start_dir)
    with open(archive.filename, 'rb') as stream:
        stream.seek(info.header_offset)
        return stream.read(end - info.header_offset)

def verify(original_path, fixed_path):
    with zipfile.ZipFile(original_path) as original, zipfile.ZipFile(fixed_path) as fixed:
        oa, fa = original.infolist(), fixed.infolist()
        original_names, fixed_names = set(original.namelist()), set(fixed.namelist())
        removed, added = sorted(original_names - fixed_names), sorted(fixed_names - original_names)
        changes = []
        for name in sorted(original_names & fixed_names):
            if original.getinfo(name).is_dir():
                continue
            before, after = sha(original.read(name)), sha(fixed.read(name))
            if before != after:
                changes.append({'path': name, 'originalSha256': before, 'fixedSha256': after})
        git = []
        for before in oa:
            if not is_git(before.filename):
                continue
            after = fixed.getinfo(before.filename) if before.filename in fixed_names else None
            metadata_differences = list(METADATA) if after is None else [field for field in METADATA if getattr(before, field) != getattr(after, field)]
            entry = {'path': before.filename, 'directory': before.is_dir(), 'size': before.file_size,
                     'originalSha256': sha(original.read(before.filename)),
                     'fixedSha256': sha(fixed.read(before.filename)) if after else None,
                     'metadataDifferences': metadata_differences,
                     'rawLocalRecordIdentical': bool(after and local_record(original, before) == local_record(fixed, after))}
            entry['bytesIdentical'] = entry['originalSha256'] == entry['fixedSha256']
            git.append(entry)
        result = {
            'originalArchiveSha256': file_sha(original_path), 'fixedArchiveSha256': file_sha(fixed_path),
            'originalEntries': len(oa), 'fixedEntries': len(fa),
            'originalRegularFiles': sum(not x.is_dir() for x in oa),
            'fixedRegularFiles': sum(not x.is_dir() for x in fa),
            'removedOriginalEntries': removed, 'addedEntries': added,
            'modifiedOriginalFiles': changes,
            'duplicateFixedEntryNames': len(fa) != len(fixed_names),
            'originalCrcError': original.testzip(), 'fixedCrcError': fixed.testzip(),
            'gitEntries': len(git), 'gitRegularFiles': sum(not x['directory'] for x in git),
            'gitAddedEntries': [name for name in added if is_git(name)],
            'gitAllFileBytesIdentical': all(x['bytesIdentical'] for x in git),
            'gitAllMetadataIdentical': all(not x['metadataDifferences'] for x in git),
            'gitAllRawLocalRecordsIdentical': all(x['rawLocalRecordIdentical'] for x in git),
            'gitEntryDetails': git,
        }
        result['passed'] = (result['originalArchiveSha256'] == EXPECTED_ORIGINAL_SHA256
                            and not removed and not result['duplicateFixedEntryNames']
                            and {c['path'] for c in changes} == EXPECTED_CHANGES
                            and not result['originalCrcError'] and not result['fixedCrcError']
                            and result['gitEntries'] > 0 and not result['gitAddedEntries']
                            and result['gitAllFileBytesIdentical'] and result['gitAllMetadataIdentical']
                            and result['gitAllRawLocalRecordsIdentical'])
        return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original', type=Path)
    parser.add_argument('fixed', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.original, args.fixed)
    except (OSError, zipfile.BadZipFile, KeyError, ValueError) as error:
        parser.exit(2, f'Archive verification failed: {error}\n')
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(encoded, encoding='utf-8')
    print(encoded, end='')
    return 0 if result['passed'] else 1

if __name__ == '__main__':
    sys.exit(main())
