export interface LoginOptions {
  fresh: boolean; // --fresh flag (now always true -- no session persistence)
}

export interface AuthResult {
  ucpath: boolean; // UCPath authenticated
  actCrm: boolean; // ACT CRM authenticated
}
