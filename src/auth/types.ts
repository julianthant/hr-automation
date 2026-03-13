export interface LoginOptions {
  fresh: boolean; // --fresh flag: ignore saved session
}

export interface AuthResult {
  ucpath: boolean; // UCPath authenticated
  actCrm: boolean; // ACT CRM authenticated
  sessionSaved: boolean; // Session persisted to .auth/
}
