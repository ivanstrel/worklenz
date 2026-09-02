// Community Edition fallback for Enterprise Edition business module
// When EDITION is not "ce", the app tries to load ../ee/business.
// This stub ensures the module is always available, falling back to CE.
import ceBusiness from "../ce/business";

export default ceBusiness;
