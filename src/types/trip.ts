/**
 * Travel Agent 的核心领域模型。
 * 这份类型同时约束前端展示、API 载荷与 AI 行程生成结果。
 */

export type ISODate = `${number}-${number}-${number}`;
export type CurrencyCode = "CNY" | "JPY" | "USD" | "EUR" | "GBP";
export type TripStatus = "draft" | "planning" | "ready" | "archived";
export type Pace = "relaxed" | "balanced" | "packed";
export type TripType = "solo" | "couple" | "friends" | "family" | "business";
export type ActivityCategory =
  | "transport"
  | "accommodation"
  | "attraction"
  | "food"
  | "shopping"
  | "nature"
  | "culture"
  | "experience"
  | "free_time";
export type TimeSlot = "morning" | "afternoon" | "evening" | "all_day";
export type PhotoUploadStatus = "pending" | "uploading" | "ready" | "failed";
export type ChecklistCategory = "documents" | "booking" | "packing" | "health" | "money" | "other";

export interface MoneyRange {
  min: number;
  max: number;
  currency: CurrencyCode;
}

export interface Place {
  name: string;
  city?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

export interface TravelerProfile {
  count: number;
  tripType?: TripType;
  hasChildren?: boolean;
  hasSeniors?: boolean;
  mobilityNeeds?: boolean;
}

export interface Budget {
  perPerson: number;
  currency: CurrencyCode;
  total?: number;
  categories: {
    transport?: MoneyRange;
    accommodation?: MoneyRange;
    food?: MoneyRange;
    activities?: MoneyRange;
    contingency?: MoneyRange;
  };
}

export interface BudgetEstimate {
  totalPerPerson: MoneyRange;
  categories: {
    transport: MoneyRange;
    accommodation: MoneyRange;
    food: MoneyRange;
    activities: MoneyRange;
    contingency: MoneyRange;
  };
  status: "unbudgeted" | "sufficient" | "near_limit" | "over_budget";
}

export interface AccommodationAreaRecommendation {
  city: string;
  area: string;
  suitableFor: string;
  advantages: string[];
  cautions: string[];
  nightlyBudget: MoneyRange;
  recommendedNights: number;
}

export interface TransportRecommendation {
  segment: string;
  mode: string;
  recommendation: string;
  notes: string[];
}

export interface TripRecommendations {
  accommodationAreas: AccommodationAreaRecommendation[];
  transportation: TransportRecommendation[];
}

export interface TripPreferences {
  interests: string[];
  pace: Pace;
  accommodationPreferences?: string[];
  foodPreferences?: string[];
  avoid: string[];
  constraints: string[];
}

export interface TravelLeg {
  mode: "flight" | "train" | "metro" | "bus" | "taxi" | "walk" | "drive" | "ferry";
  from: Place;
  to: Place;
  durationMinutes?: number;
  estimatedCost?: MoneyRange;
  notes?: string[];
}

export interface Activity {
  id: string;
  title: string;
  category: ActivityCategory;
  timeSlot: TimeSlot;
  startTime?: string;
  durationMinutes?: number;
  place?: Place;
  reason?: string;
  estimatedCost?: MoneyRange;
  travelFromPrevious?: TravelLeg;
  notes: string[];
  reservationRequired: boolean;
  locked: boolean;
}

export interface ItineraryDay {
  id: string;
  dayNumber: number;
  date: ISODate;
  city: string;
  theme: string;
  activities: Activity[];
  estimatedBudget: MoneyRange;
  walkingDistanceKm?: number;
  transitMinutes?: number;
  transportationNotes?: string[];
  tip?: string;
  locked: boolean;
}

/** 用户上传或从设备导入的一张旅行照片。实际二进制文件存储在对象存储中。 */
export interface TravelPhoto {
  id: string;
  tripId: string;
  url: string;
  thumbnailUrl?: string;
  caption?: string;
  takenAt?: string;
  place?: Place;
  dayNumber?: number;
  uploadStatus: PhotoUploadStatus;
  createdAt: string;
}

/** 一次旅行对应一个相册；封面可由用户指定或由系统从已就绪照片中推荐。 */
export interface TravelAlbum {
  id: string;
  tripId: string;
  title: string;
  coverPhotoId?: string;
  photos: TravelPhoto[];
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistItem {
  id: string;
  title: string;
  category: ChecklistCategory;
  reason: string;
  completed: boolean;
  source: "ai" | "manual";
  createdAt: string;
}

export interface TravelChecklist {
  id: string;
  tripId: string;
  items: ChecklistItem[];
  updatedAt: string;
}

export interface Trip {
  id: string;
  userId?: string;
  version: number;
  status: TripStatus;
  title: string;
  originalPrompt: string;
  origin?: string;
  destinations: string[];
  /** 用户输入的模糊出行时间，例如“十月”或“国庆假期”。 */
  travelTiming?: string;
  startDate?: ISODate;
  endDate?: ISODate;
  durationDays: number;
  travelers: TravelerProfile;
  budget?: Budget;
  budgetEstimate?: BudgetEstimate;
  recommendations?: TripRecommendations;
  preferences: TripPreferences;
  itinerary: ItineraryDay[];
  album?: TravelAlbum;
  checklist?: TravelChecklist;
  createdAt: string;
  updatedAt: string;
}

export type MissingTripField = "destinations" | "durationDays" | "travelers";

/** AI 解析后、创建旅行前在确认页中使用的临时旅行需求。 */
export interface TripIntent {
  originalPrompt: string;
  origin?: string;
  destinations: string[];
  travelTiming?: string;
  startDate?: ISODate;
  endDate?: ISODate;
  durationDays: number;
  travelers: TravelerProfile;
  budget?: Budget;
  preferences: TripPreferences;
}

export interface TripIntentAssessment {
  intent: TripIntent;
  isReady: boolean;
  missingFields: MissingTripField[];
  followUpQuestions: string[];
  changedFields: string[];
}

export interface TripRevisionRequest {
  instruction: string;
  scope: "trip" | "days";
  affectedDayNumbers?: number[];
  preserveLockedItems: boolean;
}

export interface TripRevisionResult {
  id: string;
  tripId: string;
  instruction: string;
  scope: "trip" | "days";
  affectedDayNumbers: number[];
  changeSummary: string[];
  budgetDelta: number;
  previousVersion: number;
  version: number;
  createdAt: string;
}
