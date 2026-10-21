// Parameter files, as ros2 param dump writes them and ros2 param load reads
// them: by Python's yaml (PyYAML), as ros2 param does, which ROS 2 comes with.
// A dump nests the parameters' names at their dots, under the node's full
// name and ros__parameters; a load takes the node's section (by its full name,
// or its name without the first slash) over the wildcard's (/**), and infers
// each value's type as ros2 param load does.

import { spawn } from 'node:child_process';

import type { ParamInfo, ParamType, ParamValue } from '../shared/parameters.ts';

const TIMEOUT_MS = 10_000;

const SCRIPT = String.raw`
import json, math, sys
try:
    import yaml
except ImportError:
    print(json.dumps({'error': 'Python has no yaml module: install python3-yaml, which ROS 2 comes with'}))
    sys.exit(0)

data = json.load(sys.stdin)

def number(v):
    return float(v)

def out(v):
    if isinstance(v, float):
        if math.isnan(v):
            return 'nan'
        if math.isinf(v):
            return 'inf' if v > 0 else '-inf'
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) > 2 ** 53:
        return str(v)
    return v

def typed(v):
    if isinstance(v, bool):
        return 'bool', v
    if isinstance(v, int):
        return 'integer', out(v)
    if isinstance(v, float):
        return 'double', out(v)
    if isinstance(v, str):
        return 'string', v
    if isinstance(v, list):
        if not v:
            raise ValueError('an empty list, whose type is unknown')
        if all(isinstance(x, bool) for x in v):
            return 'bool_array', v
        if all(isinstance(x, int) and not isinstance(x, bool) for x in v):
            return 'integer_array', [out(x) for x in v]
        if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
            return 'double_array', [out(float(x)) for x in v]
        if all(isinstance(x, str) for x in v):
            return 'string_array', v
        raise ValueError('a list of values of different types')
    if v is None:
        raise ValueError('no value')
    raise ValueError('a value of no parameter type')

if sys.argv[1] == 'dump':
    tree = {}
    for p in data['parameters']:
        t, v = p['type'], p['value']
        if t == 'not_set':
            continue
        if t == 'double':
            v = number(v)
        elif t == 'double_array':
            v = [number(x) for x in v]
        elif t == 'integer':
            v = int(v)
        elif t in ('integer_array', 'byte_array'):
            v = [int(x) for x in v]
        parts = p['name'].split('.')
        node = tree
        for part in parts[:-1]:
            child = node.setdefault(part, {})
            if not isinstance(child, dict):
                node = None
                break
            node = child
        if node is None or isinstance(node.get(parts[-1]), dict):
            tree[p['name']] = v
        else:
            node[parts[-1]] = v
    print(json.dumps({'yaml': yaml.dump({data['node']: {'ros__parameters': tree}}, default_flow_style=False)}))
else:
    try:
        doc = yaml.safe_load(data['yaml'])
    except yaml.YAMLError as e:
        print(json.dumps({'error': 'Not YAML: ' + str(e).replace('\n', ' ')}))
        sys.exit(0)
    node = data['node']
    if not isinstance(doc, dict):
        print(json.dumps({'error': 'Not a parameter file: it has no node names at its top'}))
        sys.exit(0)
    keys = [k for k in ('/**', '**') if k in doc] + [k for k in (node, node.lstrip('/')) if k in doc]
    if not keys:
        names = ', '.join(str(k) for k in doc)
        print(json.dumps({'error': 'No parameters of ' + node + ' in the file, only of ' + (names or 'none')}))
        sys.exit(0)
    params, errors = {}, []
    def flatten(d, prefix):
        for k, v in d.items():
            name = prefix + str(k)
            if isinstance(v, dict):
                flatten(v, name + '.')
            else:
                try:
                    params[name] = typed(v)
                except ValueError as e:
                    errors.append({'name': name, 'successful': False, 'reason': 'Not loaded: ' + str(e)})
    for k in keys:
        section = doc[k]
        if not isinstance(section, dict) or not isinstance(section.get('ros__parameters'), dict):
            print(json.dumps({'error': 'The section of ' + str(k) + ' has no ros__parameters'}))
            sys.exit(0)
        flatten(section['ros__parameters'], '')
    print(json.dumps({
        'parameters': [{'name': n, 'value': {'type': t, 'value': v}} for n, (t, v) in params.items()],
        'errors': errors,
    }))
`;

function run(mode: 'dump' | 'load', input: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', SCRIPT, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
    child.stderr.on('data', (data: Buffer) => (stderr = (stderr + data.toString()).slice(-2000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('Parameter files need python3, which ROS 2 comes with')
          : e,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout) as Record<string, unknown>;
        if (typeof result.error === 'string') {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch {
        reject(new Error(`Cannot read the parameter file (python3 exited with ${code}): ${stderr.trim()}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// As ros2 param dump writes it
export async function dumpParameters(node: string, parameters: ParamInfo[]): Promise<string> {
  const result = await run('dump', {
    node,
    parameters: parameters.map((p) => ({ name: p.name, type: p.value.type, value: p.value.value })),
  });
  return String(result.yaml);
}

export interface LoadedParameters {
  parameters: { name: string; value: ParamValue }[];
  // Those the file has but cannot be set, with why
  errors: { name: string; successful: false; reason: string }[];
}

// The node's parameters in the file, as ros2 param load reads them
export async function parseParameterFile(node: string, yaml: string): Promise<LoadedParameters> {
  const result = await run('load', { node, yaml });
  return {
    parameters: (result.parameters as { name: string; value: { type: ParamType; value: ParamValue['value'] } }[]) ?? [],
    errors: (result.errors as LoadedParameters['errors']) ?? [],
  };
}
