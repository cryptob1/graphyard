import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './process.js';

export const imagePython='/opt/graphyard-hard-math-oracle/bin/python';
// The same pins as oracle/requirements.txt, by wheel digest.
const wheels=[
  {url:'https://files.pythonhosted.org/packages/a2/09/77d55d46fd61b4a135c444fc97158ef34a095e5681d0a6c10b75bf356191/sympy-1.14.0-py3-none-any.whl',sha256:'e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5'},
  {url:'https://files.pythonhosted.org/packages/43/e3/7d92a15f894aa0c9c4b49b8ee9ac9850d6e63b03c9c32c0367a13ae62209/mpmath-1.3.0-py3-none-any.whl',sha256:'a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c'},
];

/**
 * The pinned oracle interpreter: HARD_MATH_PYTHON, the trial image's environment, or an
 * environment built in `directory` from digest-pinned wheels (callers bind it read-only). Trials run on the
 * deployed image, so a head that adds the image environment still needs the last case.
 */
export async function pinnedPython(directory:string):Promise<string> {
  if(process.env.HARD_MATH_PYTHON) return process.env.HARD_MATH_PYTHON;
  if(existsSync(imagePython)) return imagePython;
  const system=realpathSync((await command('/bin/sh',['-c','command -v python3'])).stdout.trim());
  const version=(await command(system,['-I','-c','import sys;print("%d.%d"%sys.version_info[:2])'])).stdout.trim();
  const site=join(directory,'lib',`python${version}`,'site-packages');
  await mkdir(site,{recursive:true});await mkdir(join(directory,'bin'));
  for(const wheel of wheels) {
    const response=await fetch(wheel.url,{signal:AbortSignal.timeout(120_000)});
    if(!response.ok) throw new Error(`${wheel.url} answered ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex')!==wheel.sha256) throw new Error(`${wheel.url} does not match its pinned digest`);
    const file=join(directory,'wheel.zip');await writeFile(file,bytes);
    await command(system,['-I','-c','import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',file,site]);
  }
  await writeFile(join(directory,'pyvenv.cfg'),`home = ${join(system,'..')}\ninclude-system-site-packages = false\nversion = ${version}\n`);
  await symlink(system,join(directory,'bin','python'));
  const python=join(directory,'bin','python');
  await command(python,['-I','-c','import sympy,mpmath;assert sympy.__version__=="1.14.0" and mpmath.__version__=="1.3.0"']);
  return python;
}
