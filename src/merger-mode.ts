/** The SSH origin the merge writer pushes through its deploy key. */
export const sshOrigin = (repository: string) => `git@github.com:${repository}.git`;
