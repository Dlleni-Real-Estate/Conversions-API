import type { Status } from "@/lib/stages";
import type { FormDictionary } from "@/lib/labels";

export type Lead = {
  lead_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  status: Status;
  status_at: string | null;
  notes: string | null;
  owner: string | null;
  deal_value: number | null;
  submitted_at: string;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  form_name: string | null;
  platform: string | null;
  raw_fields: Record<string, string> | null;
  quality_score?: number | null;
  note_count?: number;
  /** Newest note on this lead - usually what the agent wrote in 8X. */
  last_note?: { body: string; author: string | null; at: string | null } | null;
  rank?: number;
};

export type AdRow = {
  ad_id: string;
  ad_name: string | null;
  adset_id?: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  spend: number;
  reach: number;
  impressions: number;
  frequency: number;
  clicks: number;
  link_clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  meta_leads: number;
  meta_cost_per_lead: number | null;
  currency: string | null;
  date_start: string | null;
  date_stop: string | null;
  leads: number;
  untouched: number;
  worked: number;
  no_answer: number;
  qualified: number;
  meetings_booked: number;
  meetings_done: number;
  site_visits_booked: number;
  site_visits_done: number;
  eoi: number;
  reservations: number;
  avg_quality?: number | null;
  disqualified: number;
  reservation_value: number;
  qualified_pct: number | null;
  disqualified_pct: number | null;
  no_show_pct: number | null;
  cost_per_lead: number | null;
  cost_per_qualified: number | null;
  cost_per_site_visit: number | null;
  cost_per_reservation: number | null;
};

export type CampaignBoardRow = {
  campaign_id: string;
  campaign_name: string;
  ad_account_id?: string | null;
  spend: number;
  meta_leads: number;
  leads: number;
  untouched: number;
  no_answer: number;
  disqualified: number;
  qualified: number;
  qualified_pct: number | null;
  avg_quality?: number | null;
  reservations: number;
  cost_per_lead: number | null;
  cost_per_qualified: number | null;
  currency: string | null;
  date_start: string | null;
  date_stop: string | null;
};

export type AccountRef = {
  ad_account_id: string;
  name: string | null;
  business_name: string | null;
  enabled: boolean;
};

export type Analytics = {
  ok: boolean;
  /** Which single ad account the whole payload is narrowed to, null = all. */
  account?: string | null;
  /** Which single ad set, null = all of them. */
  adset?: string | null;
  /** Every connected account, for the header switcher and the board badges. */
  accounts?: AccountRef[];
  currency: string;
  /** Every currency in scope. More than one means the totals below are mixed. */
  currencies?: string[];
  mixedCurrency?: boolean;
  scope: string | null;
  campaigns: { id: string; name: string }[];
  /** Ad sets that actually have leads in the current scope. */
  adsets?: { id: string; name: string; campaign_id: string | null }[];
  /** One row per campaign, same yardstick — present only when scope is "all". */
  campaignBoard?: CampaignBoardRow[] | null;
  /** Straight from Meta — nothing here is derived from our lead table. */
  meta: {
    spend: number;
    impressions: number;
    clicks: number;
    link_clicks: number;
    /** null when more than one campaign is in scope — reach cannot be added. */
    reach: number | null;
    frequency: number | null;
    reach_exact: boolean;
    ctr: number | null;
    cpc: number | null;
    cpm: number | null;
    leads: number;
    cost_per_lead: number | null;
    currency: string;
    date_start: string | null;
    date_stop: string | null;
    campaigns: number;
  };
  kpis: {
    leads: number;
    untouched: number;
    spend: number;
    reach: number;
    impressions: number;
    clicks: number;
    ctr: number | null;
    cost_per_lead: number | null;
    qualified: number;
    qualified_pct: number | null;
    cost_per_qualified: number | null;
    site_visits: number;
    cost_per_site_visit: number | null;
    reservations: number;
    cost_per_reservation: number | null;
    reservation_value: number;
    roas: number | null;
    median_response_hours: number | null;
    contacted_within_hour_pct: number | null;
  };
  funnel: {
    status: string;
    label: string;
    count: number;
    accent: string;
    fromPrev: number | null;
    ofTotal: number | null;
  }[];
  byStatus: Record<Status, number>;
  ads: AdRow[];
  daily: { date: string; leads: number; qualified: number; reservations: number }[];
  segments: {
    field: string;
    /** The question as written on the form — never translated, just looked up. */
    label: string;
    values: {
      value: string;
      /** The answer as written on the form. */
      label: string;
      leads: number;
      qualified: number;
      reservations: number;
      qualified_pct: number | null;
    }[];
  }[];
  dictionary: FormDictionary;
  platforms: { platform: string; leads: number; qualified: number; qualified_pct: number | null }[];
};
