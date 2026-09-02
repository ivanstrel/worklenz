// Community Edition business module
// This module provides the open-source (AGPLv3) business logic for Worklenz.
// The ee/business.ts stub re-exports this module as a fallback for the
// Enterprise Edition build path.
//
// The business module is part of the open-core edition structure. When the
// EDITION environment variable is "ce", this module is used directly; when it
// is not "ce", the ee/business.ts stub re-exports this implementation.
export default {};
