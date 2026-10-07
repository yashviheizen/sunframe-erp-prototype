// Shared data model. Every record has a stable `id`; cross-links use those ids.

export type ID = string;
export type ISODate = string; // yyyy-mm-dd

export const LEAD_STAGES = ['New', 'Warm', 'Hot', 'Quote sent', 'Negotiation', 'Closed', 'Lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
/** Stages counted in the open pipeline. Closed (won) and Lost are excluded from pipeline totals. */
export const OPEN_STAGES: LeadStage[] = ['New', 'Warm', 'Hot', 'Quote sent', 'Negotiation'];

export const UNITS = ['kg', 'MT', 'pcs', 'm', 'sets', 'rolls', 'litres'] as const;
export const MATERIAL_CATEGORIES = ['Steel coil', 'Fasteners', 'Consumables', 'Zinc / galvanizing', 'Packaging', 'Other'] as const;
export const PRODUCT_CATEGORIES = ['Steel coil', 'Fasteners', 'Consumables', 'Zinc / galvanizing', 'Packaging', 'Job work', 'Other'] as const;

export const DOC_CATEGORIES = [
  'Client PO', 'Supplier quotation', 'Supplier PO', 'Quote', 'Sales order',
  'Engineering drawing', 'GRN', 'POD', 'Payment proof', 'Licence', 'Other',
] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export type Role = 'admin' | 'user';
/** Simulated users: switching user in the top bar changes permissions; there is no sign-in. */
export interface User { id: ID; name: string; role: Role; title: string; email?: string; department?: string }

/** Fictional sample records carry this flag (set by the versioned seed in src/seed.ts). */
export interface Tagged { isSample?: boolean }

export interface Activity extends Tagged { id: ID; at: string; userName: string; text: string; leadId?: ID }

export interface FileMeta { fileId: ID; name: string; mime: string; size: number }

export interface Lead extends Tagged {
  id: ID; ref: string;
  company: string; contact: string;
  email: string; phone: string; project: string;
  estValue: number | null; owner: string; nextFollowUp: ISODate | '';
  stage: LeadStage; createdAt: string; closedAt?: string;
}

export interface Material extends Tagged {
  id: ID; code: string; name: string; category: string; unit: string;
  onHand: number;
}

export interface BomLine { id: ID; materialId: ID; qty: number }
export interface Bom extends Tagged {
  id: ID; ref: string; leadId: ID;
  productName: string; outputQty: number; outputUnit: string;
  lines: BomLine[]; notes: string; updatedAt: string;
}

export interface PriceLine { id: ID; description: string; qty: number; unit: string; rate: number }

export interface Quote extends Tagged {
  id: ID; ref: string; leadId: ID; bomId: ID; version: number;
  date: ISODate; validDays: number;
  lines: PriceLine[]; discountPct: number; freight: number; gstPct: number;
  paymentTerms: string; deliveryTerms: string; terms: string;
  status: 'Draft' | 'Quote sent'; sentAt?: string;
}

export interface ClientPO extends Tagged {
  id: ID; leadId: ID;
  poNumber: string; poDate: ISODate;
  lines: PriceLine[]; amount: number;
  paymentTerms: string; deliveryTerms: string; deliveryAddress: string; terms: string;
  file?: FileMeta; documentId?: ID; createdAt: string;
}

export interface SalesOrder extends Tagged {
  id: ID; ref: string; leadId: ID; clientPoId: ID;
  date: ISODate; expectedDelivery: ISODate | '';
  lines: PriceLine[]; discountPct: number; freight: number; gstPct: number;
  paymentTerms: string; deliveryTerms: string; deliveryAddress: string; terms: string;
  subtotal: number; total: number; documentId?: ID;
}

export interface MoRequirement { materialId: ID; required: number }
export interface ManufacturingOrder extends Tagged {
  id: ID; ref: string; leadId: ID; soId: ID; bomId: ID;
  productName: string; qty: number; unit: string;
  plannedDate: ISODate | ''; createdAt: string;
  requirements: MoRequirement[];
  line: 'Line 1' | 'Line 2' | null;
  stageId: ID; // id into db.stages (first = material issue, last = finished goods ready)
  materialsIssued: boolean;
  fgPosted: boolean;
  /** Set when the SO quantity differed from the BOM output and the user explicitly reconciled it. */
  reconciliation?: { soQty: number; bomOutput: number; note: string; by: string; at: string };
  log: { at: string; text: string }[];
}

export interface Reservation extends Tagged { id: ID; moId: ID; materialId: ID; qty: number; status: 'Reserved' | 'Issued' }

export type PRStatus = 'Pending' | 'Approved' | 'Rejected';
export interface PRLine { id: ID; materialId: ID; qty: number; requestedQty: number }
export interface PurchaseRequest extends Tagged {
  id: ID; ref: string; source: 'Manual' | 'Material shortfall';
  moId?: ID; raisedById: ID; raisedByName: string;
  lines: PRLine[]; requiredBy: ISODate | ''; notes: string;
  status: PRStatus; createdAt: string; decidedAt?: string; decidedBy?: string;
  poId?: ID;
}

export interface Supplier extends Tagged {
  id: ID; name: string; gst: string; contact: string; phone: string; email: string;
  category: string; active: boolean; createdAt: string;
}

export interface SupplierQuotation extends Tagged {
  id: ID; supplierId: ID; category: string; reference: string; date: ISODate;
  file: FileMeta; documentId: ID;
}

export interface POLine { id: ID; materialId: ID; qty: number; rate: number }
export interface SupplierPO extends Tagged {
  id: ID; ref: string; supplierId: ID | null; prId?: ID;
  date: ISODate; lines: POLine[]; expectedDelivery: ISODate | '';
  paymentTermsDays: 30 | 60 | 90 | null;
  status: 'Details required' | 'Approved';
  receiptStatus: 'Not received' | 'Received';
  quotationIds: ID[]; grnId?: ID; documentId?: ID; createdAt: string;
}

export interface GRN extends Tagged {
  id: ID; number: string; poId: ID; date: ISODate;
  lines: { materialId: ID; qty: number }[];
  file?: FileMeta; documentId?: ID;
}

export interface FGItem extends Tagged {
  id: ID; moId: ID; soId: ID; leadId: ID;
  productName: string; unit: string; producedQty: number; dispatchedQty: number; postedAt: string;
}

export interface Dispatch extends Tagged {
  id: ID; ref: string; moId: ID; soId: ID; leadId: ID; qty: number; unit: string;
  status: 'Ready' | 'Dispatched'; readyAt: string;
  dispatchDate?: ISODate; vehicleNo?: string; transporter?: string; driver?: string; lrNumber?: string;
  pod?: FileMeta; podDocumentId?: ID; receivableId?: ID;
}

export interface Payment {
  id: ID; date: ISODate; amount: number; mode: string; reference: string;
  proof?: FileMeta; documentId?: ID;
}

export interface Receivable extends Tagged {
  id: ID; ref: string; leadId: ID; soId: ID; dispatchId: ID;
  amount: number; paymentTerms: string; dueDate: ISODate; payments: Payment[]; createdAt: string;
}

export interface Payable extends Tagged {
  id: ID; ref: string; poId: ID; supplierId: ID;
  amount: number; termsDays: number; poDate: ISODate; dueDate: ISODate; payments: Payment[]; createdAt: string;
}

export interface DocumentRec extends Tagged {
  id: ID; name: string; file: FileMeta;
  partyType: 'client' | 'supplier' | 'none'; partyName: string;
  category: DocCategory; linkedRef: string; uploadedAt: string; expiry: ISODate | '';
  source: 'Upload' | 'Generated';
  /** Stable-id links (no name/prefix matching). */
  leadId?: ID; supplierId?: ID; refType?: DocRefType; refId?: ID;
}
export type DocRefType = 'quote' | 'cpo' | 'so' | 'mo' | 'po' | 'grn' | 'dispatch' | 'receivable' | 'payable' | 'quotation';

/** One material issue event, written when materials are issued against an MO. Never back-filled. */
export interface MaterialIssue extends Tagged {
  id: ID; moId: ID; line: 'Line 1' | 'Line 2'; materialId: ID; qty: number; unit: string;
  at: string; issuedById: ID; issuedByName: string;
}

/* ---------------- HRMS (basic lists; no statutory payroll rules) */
export const DEPARTMENTS = ['Production', 'Stores', 'Purchase', 'Sales', 'Accounts', 'Quality', 'Admin'] as const;
export type EmployeeStatus = 'Active' | 'On notice' | 'Inactive';
export interface Employee extends Tagged {
  id: ID; code: string; name: string; department: string; designation: string;
  lineShift: string; phone: string; joinedOn: ISODate; monthlySalary: number; status: EmployeeStatus;
}
export const LEAVE_TYPES = ['Casual', 'Sick', 'Earned'] as const;
export interface LeaveRequest extends Tagged {
  id: ID; employeeId: ID; type: (typeof LEAVE_TYPES)[number]; from: ISODate; to: ISODate; days: number;
  reason: string; status: 'Pending' | 'Approved' | 'Rejected'; createdAt: string; decidedBy?: string; decidedAt?: string;
}
/** A month's payroll entered as totals. Gross is the sum of monthly salaries; deductions are entered, not computed. */
export interface PayrollRun extends Tagged {
  id: ID; month: string; employees: number; gross: number; deductions: number; net: number;
  status: 'Draft' | 'Completed'; notes: string; createdAt: string; completedAt?: string; completedBy?: string;
}

/** Company details printed on PDFs. Empty = a labelled placeholder is printed instead. */
export interface Settings {
  legalName: string; address: string; gstin: string; contact: string;
  quoteTerms: string; quotePaymentTerms: string; quoteDeliveryTerms: string; poNotes: string;
}

export type StageGroup = 'Material issue' | 'Production' | 'Packaging' | 'Finished goods';
export interface StageDef { id: ID; name: string; group: StageGroup }

export interface DB {
  version: number;
  counters: Record<string, number>;
  users: User[]; currentUserId: ID;
  stages: StageDef[];
  leads: Lead[]; materials: Material[]; boms: Bom[]; quotes: Quote[];
  clientPOs: ClientPO[]; salesOrders: SalesOrder[]; mos: ManufacturingOrder[];
  reservations: Reservation[]; prs: PurchaseRequest[];
  suppliers: Supplier[]; supplierQuotations: SupplierQuotation[]; supplierPOs: SupplierPO[];
  grns: GRN[]; fgItems: FGItem[]; dispatches: Dispatch[];
  receivables: Receivable[]; payables: Payable[];
  documents: DocumentRec[]; activities: Activity[];
  materialIssues: MaterialIssue[];
  employees: Employee[]; leaves: LeaveRequest[]; payrollRuns: PayrollRun[];
  settings: Settings;
  /** Sample-data bookkeeping: which seed version has been applied, and whether the user opted out (reset). */
  meta?: { seedVersion?: number; seedOptOut?: boolean };
}
