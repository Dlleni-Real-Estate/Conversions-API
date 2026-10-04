/**
 * One lead from Meta -> one row in `leads`, defined ONCE.
 *
 * Two readers store leads: the ten-minute sync (every tracked campaign) and
 * the one-minute agent tick (routed campaigns only, for speed). Two copies of
 * this mapping would drift the way the stage chain once did, and a lead stored
 * two different ways depending on which reader saw it first is a bug nobody
 * would ever spot.
 */

import { flattenFields, normalizeEgyptPhone, type AccountScope, type CampaignAd, type RawLead } from "./meta";

export function leadRow(
  lead: RawLead,
  ad: CampaignAd,
  campaign: { id: string; name: string },
  scope: AccountScope,
  formNames: Map<string, string>
): Record<string, unknown> {
  const { fields, full_name, phone, email } = flattenFields(lead);
  return {
    lead_id: lead.id,
    form_id: lead.form_id ?? null,
    form_name: (lead.form_id && formNames.get(lead.form_id)) || null,
    page_id: scope.pageId || process.env.META_PAGE_ID,
    ad_account_id: scope.adAccountId,
    // Names come from the walk, so they are right even when Meta omits them
    // from the lead object.
    ad_id: ad.id,
    ad_name: ad.name,
    adset_id: ad.adset_id ?? lead.adset_id ?? null,
    adset_name: ad.adset_name ?? lead.adset_name ?? null,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    platform: lead.platform ?? null,
    is_organic: lead.is_organic ?? false,
    submitted_at: lead.created_time,
    full_name: full_name ?? null,
    phone: normalizeEgyptPhone(phone) ?? null,
    email: email ?? null,
    raw_fields: fields,
    synced_at: new Date().toISOString(),
  };
}
