#!/usr/bin/env python3
"""Read-only verification that the optimized ZIP preserves the original project and .git.
Run: python scripts/verify-resource-efficiency-archive.py original.zip optimized.zip
Only the three documented production files may differ. Added audit/test files are
allowed. No archive is extracted; neither .git nor either ZIP is modified.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

EXPECTED_CHANGES = {'public/app.js', 'public/draft-store.js', 'public/editor-history.js'}
META_FIELDS = ('date_time', 'external_attr', 'internal_attr', 'create_system',
               'create_version', 'extract_version', 'extra', 'comment', 'compress_type')


def sha256_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def verify(original: Path, modified: Path) -> dict:
    failures: list[str] = []
    with zipfile.ZipFile(original) as before, zipfile.ZipFile(modified) as after:
        before_names, after_names = before.namelist(), after.namelist()
        if len(set(before_names)) != len(before_names) or len(set(after_names)) != len(after_names):
            failures.append('Duplicate ZIP entries detected')
        missing = sorted(set(before_names) - set(after_names))
        added = sorted(set(after_names) - set(before_names))
        if missing:
            failures.append('Original entries are missing')
        changed: list[str] = []
        git_entries = [name for name in before_names if name == '.git/' or name.startswith('.git/')]
        final_git_entries = [name for name in after_names if name == '.git/' or name.startswith('.git/')]
        if set(git_entries) != set(final_git_entries):
            failures.append('.git entry list differs')
        git_meta_differences = []
        git_hash_differences = []
        original_files = 0
        for name in before_names:
            left = before.getinfo(name)
            if not left.is_dir():
                original_files += 1
            if name not in after_names:
                continue
            right = after.getinfo(name)
            left_hash = hashlib.sha256(before.read(name)).hexdigest()
            right_hash = hashlib.sha256(after.read(name)).hexdigest()
            if left_hash != right_hash:
                changed.append(name)
                if name in git_entries:
                    git_hash_differences.append(name)
            if name in git_entries:
                fields = [field for field in META_FIELDS if getattr(left, field) != getattr(right, field)]
                if fields:
                    git_meta_differences.append({'entry': name, 'fields': fields})
        if set(changed) != EXPECTED_CHANGES:
            failures.append('Changed original files do not match the three-file allowlist')
        if git_hash_differences or git_meta_differences:
            failures.append('.git content or recorded metadata differs')
        original_bad_crc, modified_bad_crc = before.testzip(), after.testzip()
        if original_bad_crc or modified_bad_crc:
            failures.append('ZIP CRC verification failed')
        return {
            'passed': not failures, 'failures': failures,
            'originalSha256': sha256_file(original), 'modifiedSha256': sha256_file(modified),
            'originalEntries': len(before_names), 'originalFiles': original_files,
            'modifiedEntries': len(after_names), 'missingOriginalEntries': missing,
            'changedOriginalFiles': sorted(changed), 'addedEntries': added,
            'gitEntries': len(git_entries),
            'gitFiles': sum(not before.getinfo(name).is_dir() for name in git_entries),
            'gitContentHashDifferences': git_hash_differences,
            'gitMetadataDifferences': git_meta_differences,
            'verifiedGitMetadataFields': list(META_FIELDS),
            'originalCrcFailure': original_bad_crc, 'modifiedCrcFailure': modified_bad_crc,
            'scope': 'File bytes and ZIP-recorded .git metadata are preserved; ZIP container compression bytes need not be identical.'
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original', type=Path)
    parser.add_argument('modified', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        report = verify(args.original, args.modified)
    except (OSError, zipfile.BadZipFile) as exc:
        parser.error(str(exc))
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(text + '\n')
    print(text)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
