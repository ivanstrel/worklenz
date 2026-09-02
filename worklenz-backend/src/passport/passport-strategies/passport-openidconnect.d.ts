declare module "passport-openidconnect" {
  import { Strategy as BaseStrategy } from "passport-strategy";

  export interface OpenIDConnectStrategyOptions {
    issuer: string;
    authorizationURL: string;
    tokenURL: string;
    userInfoURL?: string;
    clientID: string;
    clientSecret: string;
    callbackURL: string;
    scope?: string[];
    passReqToCallback?: boolean;
    [key: string]: any;
  }

  export interface OpenIDConnectProfile {
    id: string;
    displayName?: string;
    username?: string;
    emails?: Array<{ value: string; type?: string }>;
    photos?: Array<{ value: string; type?: string }>;
    name?: {
      familyName?: string;
      givenName?: string;
      middleName?: string;
    };
    [key: string]: any;
  }

  export class Strategy extends BaseStrategy {
    constructor(
      options: OpenIDConnectStrategyOptions,
      verify: (req: any, issuer: string, profile: OpenIDConnectProfile, done: (err: any, user?: any, info?: any) => void) => void
    );
    constructor(
      options: OpenIDConnectStrategyOptions,
      verify: (issuer: string, profile: OpenIDConnectProfile, done: (err: any, user?: any, info?: any) => void) => void
    );
  }

  export default Strategy;
}
