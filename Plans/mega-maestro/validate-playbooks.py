#!/usr/bin/env python3
"""Validate planning structure only; never claim runtime enforcement readiness."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

TASK = re.compile(r"^- \[[ xX]\] ([A-Z][A-Z0-9-]+)(?: |:)", re.MULTILINE)
SHARED_KEYS = ('baselineDigests', 'executionMode', 'automaticHandoffs', 'launchEntry',
               'executionProfiles', 'sharedDependencies', 'externalQualificationTasks', 'requiredHumanGates')


def owned_plan(plan, roots, errors):
    """Compose owner-maintained tracks without requiring repair-history copies."""
    result = json.loads(json.dumps(plan))
    for name, root in roots.items():
        snapshot = root / plan['tracks'][name]['designDirectory'] / 'execution-plan.json'
        if not snapshot.is_file():
            errors.append(f'Missing owner execution plan: {snapshot}')
            continue
        owner = json.loads(snapshot.read_text())
        for key in SHARED_KEYS:
            if owner.get(key) != plan.get(key):
                errors.append(f'Shared schedule mismatch ({key}): {snapshot}')
        previous_ids = {t for d in result['tracks'][name]['documents'] for t in d['tasks']}
        result['tracks'][name] = owner['tracks'][name]
        owned_ids = {t for d in owner['tracks'][name]['documents'] for t in d['tasks']}
        result['additionalDependencies'] = {
            k: v for k, v in result['additionalDependencies'].items() if k not in previous_ids
        }
        result['additionalDependencies'].update({
            k: v for k, v in owner['additionalDependencies'].items() if k in owned_ids
        })
    for task, dependencies in plan.get('sharedDependencies', {}).items():
        if result['additionalDependencies'].get(task) != dependencies:
            errors.append(f'Mandatory shared dependency changed: {task}')
    return result


def executable_lines(text):
    """Ignore fenced examples, as Maestro does when dispatching tasks/markers."""
    fence = None
    for line in text.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            token = marker[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence is None:
            yield line


def document_blockers(text):
    lines = list(executable_lines(text))
    blockers = []
    for index, line in enumerate(lines):
        if re.fullmatch(r'\s*<!--\s*maestro:halt(?:\s*:[\s\S]*?)?\s*-->\s*', line):
            blockers.append('Persisted halt: ' + line.strip())
        if re.fullmatch(r'\s*<!--\s*MAESTRO:HITL\s+.*-->\s*', line):
            next_line = next((value.strip() for value in lines[index + 1:] if value.strip()), '')
            if not re.match(r'^- \[[xX]\] Human step done\b', next_line):
                blockers.append('Human step pending: ' + line.strip())
    return blockers


def validate(plan_path, roots, batch='all', require_ready=False):
    plan = json.loads(plan_path.read_text())
    errors = []
    plan = owned_plan(plan, roots, errors)
    notices = []
    graph = {}
    task_locations = {}
    launch_blockers = []
    texts = {}
    declared_dependencies = {}
    selected = set(plan['foundationRecovery']['documents']) if batch == 'foundations' else {
        d['path'] for track in plan['tracks'].values() for d in track['documents']
    }
    for track_name, track in plan['tracks'].items():
        previous = None
        count = 0
        root = roots.get(track_name)
        expected_files = set()
        for document in track['documents']:
            relative = Path(document['path'])
            if relative.is_absolute() or '..' in relative.parts:
                errors.append(f'Nonportable document path: {relative}')
                continue
            expected_files.add(relative)
            if root is not None:
                path = root / relative
                if not path.is_file():
                    errors.append(f'Missing document: {path}')
                else:
                    text = path.read_text()
                    executable = '\n'.join(executable_lines(text))
                    actual = TASK.findall(executable)
                    texts[str(relative)] = executable
                    required_gate = plan.get('requiredHumanGates', {}).get(str(relative))
                    if required_gate and not any('MAESTRO:HITL' in line and required_gate in line
                                                 for line in executable.splitlines()):
                        errors.append(f'Missing mandatory human prerequisite: {path}')
                    for line in executable.splitlines():
                        if re.match(r'^- \[ \]', line) and not TASK.match(line):
                            errors.append(f'Unchecked task lacks a manifest ID: {path}: {line}')
                        task = TASK.match(line)
                        requires = re.search(r'\bRequires ([^.]+)\.', line)
                        if task and requires:
                            declared_dependencies[task[1]] = re.findall(r'\b(?:MM|MINT|CHAIN)-[A-Z0-9-]+\b', requires[1])
                    if actual != document['tasks']:
                        errors.append(f'Task order/coverage differs from manifest: {path}')
                    if 'execution_root: ' + track_name not in text:
                        errors.append(f'Wrong execution root: {path}')
                    if track_name == 'maestro' and 'required_branch: feature/mega-maestro-integration' not in text:
                        errors.append(f'Missing branch guard: {path}')
                    blockers = document_blockers(text)
                    notices.extend(f'{path}: {blocker}' for blocker in blockers)
                    if str(relative) in selected:
                        launch_blockers.extend(f'{path}: {blocker}' for blocker in blockers)
                    if '\u2014' in text or '\u2013' in text:
                        errors.append(f'Unsupported dash style: {path}')
            for task_id in document['tasks']:
                if task_id in graph:
                    errors.append(f'Duplicate task ID: {task_id}')
                graph[task_id] = [previous] if previous else []
                task_locations[task_id] = str(relative)
                previous = task_id
                count += 1
        if count != track['taskCount']:
            errors.append(f'Incorrect task count: {track_name}')
        if root is not None:
            actual_files = {
                path.relative_to(root)
                for path in (root / track['playbookDirectory']).glob('*.md')
            }
            if actual_files != expected_files:
                errors.append(f'Unscheduled/missing phase documents: {track_name}')
            design_dir = root / track['designDirectory']
            for filename, expected_digest in plan['baselineDigests'].items():
                path = design_dir / filename
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected_digest:
                    errors.append(f'Baseline digest mismatch: {path}')
        else:
            notices.append(f'{track_name} files not inspected; graph checked from shared manifest only')
        if root is None:
            launch_blockers.extend(f'Uninspected selected document: {d["path"]}'
                                   for d in track['documents'] if d['path'] in selected)

    known_documents = {d['path'] for track in plan['tracks'].values() for d in track['documents']}
    if not selected <= known_documents:
        errors.append('Selected batch contains unknown documents')
    foundation_docs = plan['foundationRecovery']['documents']
    expected_foundations = [d['path'] for d in plan['tracks']['application']['documents'][:6]]
    if foundation_docs != expected_foundations:
        errors.append('Foundation batch must contain phases 01-06 in manifest order')

    for task_id, dependencies in plan['additionalDependencies'].items():
        if task_id not in graph:
            errors.append(f'Unknown dependent task: {task_id}')
            continue
        graph[task_id].extend(dependencies)
    for task_id, dependencies in declared_dependencies.items():
        graph[task_id].extend(dependencies)
    for task_id, dependencies in graph.items():
        for dependency in dependencies:
            if dependency not in graph:
                errors.append(f'Unknown prerequisite: {task_id} -> {dependency}')

    pending = set(graph)
    resolved = set()
    while pending:
        ready = {task_id for task_id in pending if set(graph[task_id]) <= resolved}
        if not ready:
            errors.append('Cyclic or unresolved dependencies: ' + ', '.join(sorted(pending)))
            break
        resolved.update(ready)
        pending.difference_update(ready)


    # Check that executable handoffs cover every automated document exactly once,
    # alternate repository owners, and do not schedule a consumer before producers.
    handoffs = plan.get('automaticHandoffs', [])
    if handoffs:
        entry = plan.get('launchEntry', {})
        batches = [(entry.get('track'), entry.get('documents', []))]
        for handoff in handoffs:
            source_track, source_docs = batches[-1]
            source = handoff['sourceDocument']
            task_id = handoff['taskId']
            if source_track != handoff['sourceTrack'] or not source_docs or source_docs[-1] != source:
                errors.append(f'Handoff source is not the batch end: {task_id}')
            source_task_ids = next((d['tasks'] for d in plan['tracks'][handoff['sourceTrack']]['documents'] if d['path'] == source), [])
            if not source_task_ids or source_task_ids[-1] != task_id:
                errors.append(f'Handoff task must be last: {task_id}')
            if handoff['targetTrack'] == source_track:
                errors.append(f'Handoff must target the other agent: {task_id}')
            if not handoff.get('targetAgent'):
                errors.append(f'Missing target agent: {task_id}')
            source_text = texts.get(source)
            if source_text is not None:
                task_line = next((line for line in source_text.splitlines()
                                  if TASK.match(line) and TASK.match(line)[1] == task_id), '')
                expected = [handoff['targetAgent'], '--launch', *handoff['targetDocuments']]
                if any(value not in task_line for value in expected):
                    errors.append(f'Handoff command differs from schedule: {task_id}')
            batches.append((handoff['targetTrack'], handoff['targetDocuments']))
        scheduled_docs = []
        scheduled_tasks = set()
        for track_name, paths in batches:
            if track_name not in plan['tracks']:
                errors.append('Unknown chain track')
                continue
            lookup = {d['path']: d['tasks'] for d in plan['tracks'][track_name]['documents']}
            for path in paths:
                scheduled_docs.append(path)
                if path not in lookup:
                    errors.append(f'Unknown chain document: {path}')
                    continue
                for task_id in lookup[path]:
                    if not set(graph.get(task_id, [])) <= scheduled_tasks:
                        errors.append(f'Chain runs before prerequisite: {task_id}')
                    scheduled_tasks.add(task_id)
        expected_docs = {d['path'] for t in plan['tracks'].values() for d in t['documents']}
        if len(scheduled_docs) != len(set(scheduled_docs)) or set(scheduled_docs) != expected_docs:
            errors.append('Complete chain must cover each document exactly once')

    complete = plan.get('executionProfiles', {}).get('complete', {})
    if complete.get('completionTask') != 'MM-24-01' or 'MM-24-01' not in graph:
        errors.append('Complete profile lacks its final delivery acceptance task')
    if handoffs and (handoffs[-1]['targetDocuments'][-1] != task_locations.get('MM-24-01')):
        errors.append('Complete chain does not end at delivery acceptance')

    required_edges = {
        'MINT-E01-00': 'MM-E01-11',
        'MM-E02-01': 'MINT-E01-10',
        'MINT-02-03': 'MM-E02-04',
        'MM-07-01': 'MM-E02-04',
        'MINT-03-00': 'MM-22-04',
        'MM-23-01': 'MINT-03-03',
        'MINT-03-04': 'MM-23-03',
        'MM-23-04': 'MINT-03-04',
    }
    for dependent, prerequisite in required_edges.items():
        if prerequisite not in graph.get(dependent, []):
            errors.append(f'Missing mandatory gate: {dependent} requires {prerequisite}')
    for task_id in ['MM-21-05', 'MM-23-04']:
        if not task_locations.get(task_id, '').endswith('MEGA-MAESTRO-24.md'):
            errors.append(f'External qualification task is not isolated: {task_id}')

    # Checks provenance preservation, including IDs relocated to phase 24.
    original_ids = plan['preservedTaskIds']
    if len(original_ids) != len(set(original_ids)):
        errors.append('Duplicate preserved task IDs in manifest')
    missing_originals = set(original_ids) - graph.keys()
    if missing_originals:
        errors.append('Missing original tasks: ' + ', '.join(sorted(missing_originals)))

    print(json.dumps({
        'status': 'invalid' if errors else 'valid-planning-structure',
        'tasks': len(graph),
        'documents': sum(len(track['documents']) for track in plan['tracks'].values()),
        'originalTasksPreserved': len(original_ids) - len(missing_originals),
        'errors': errors,
        'notices': notices,
        'selectedBatch': batch,
        'launchBlockers': launch_blockers,
        'readyForDispatch': not errors and not launch_blockers,
        'runtimeEvidenceValidated': False,
    }, indent=2))
    return 1 if errors else (2 if require_ready and launch_blockers else 0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--application-root', type=Path)
    parser.add_argument('--maestro-root', type=Path)
    parser.add_argument('--batch', choices=['all', 'complete', 'foundations'], default='all')
    parser.add_argument('--require-ready', action='store_true',
                        help='Exit 2 for unresolved human steps/halts in the selected batch; does not validate runtime evidence')
    args = parser.parse_args()
    roots = {key: value.resolve() for key, value in {
        'application': args.application_root,
        'maestro': args.maestro_root,
    }.items() if value is not None}
    if not roots:
        parser.error('Supply at least one repository root for file validation')
    sys.exit(validate(Path(__file__).with_name('execution-plan.json'), roots, args.batch, args.require_ready))
