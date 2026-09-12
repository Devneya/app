export const subscriptionStatuses = [
  "none", "pending", "active", "past_due", "cancelled", "expired", "review_required",
] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export const billingActions = [
  "subscribe", "none", "uncancel", "update_payment", "contact_support",
] as const;

export type UsageResponse = {
  used: number;
  limit: number;
  subscription_status: SubscriptionStatus;
  entitlement_status: SubscriptionStatus;
  cancel_at_period_end: boolean;
  access_until: string | null;
  required_billing_action: (typeof billingActions)[number];
};

export type SubscribeResponse = {
  status: "checkout";
  checkout_url: string;
  expires_at: string;
};

export type CancelSubscriptionResponse = {
  status: string;
  cancel_at_period_end: boolean;
  access_until: string | null;
};

export type KeyResponse = {
  key: string;
};

export type ModelObject = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type ModelsListResponse = {
  object: string;
  data: ModelObject[];
};
