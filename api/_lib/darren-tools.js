// Function-calling tools exposed to Darren during a live call.
//
// Kept deliberately small: one tool to actually persist a lead, one to end
// the call cleanly, and one (conditional on a transfer target actually being
// configured) to hand off to a human. This mirrors the "never claim
// something happened unless the system confirms it" rule in the system
// prompt — every one of these tools returns a real ok/failure result that
// the model has to react to honestly.

export const SUBMIT_LEAD_TOOL = {
  type: 'function',
  name: 'submit_lead',
  description:
    'Persists the caller\'s enquiry as a lead for the business to follow up on. Call this once you have ' +
    'gathered enough information to be useful (at minimum a name, a callback number, and what they need). ' +
    'Only tell the caller their message has been passed on after this tool reports { ok: true }.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      caller_name: {
        type: 'string',
        description: "The caller's name, as they gave it.",
      },
      callback_number: {
        type: 'string',
        description:
          'The best number to call them back on, as confirmed with the caller (digits, spaces, and + are fine).',
      },
      job_type: {
        type: 'string',
        description: 'The job or service they need, e.g. "boiler repair", "blocked drain", "rewire quote".',
      },
      problem_details: {
        type: 'string',
        description: 'Relevant details about the problem or request, in the caller\'s own terms.',
      },
      location: {
        type: 'string',
        description: 'Town/area, or a fuller address if relevant to the job.',
      },
      urgency: {
        type: 'string',
        enum: ['emergency', 'today', 'this_week', 'flexible', 'unspecified'],
        description: 'How urgent the caller indicated this is.',
      },
      preferred_callback_time: {
        type: 'string',
        description: 'When the caller would like to be called back, if they said.',
      },
      call_summary: {
        type: 'string',
        description: 'A one or two sentence summary of the call, for the business to read at a glance.',
      },
    },
    required: ['caller_name', 'callback_number', 'job_type'],
  },
};

export const END_CALL_TOOL = {
  type: 'function',
  name: 'end_call',
  description:
    'Ends the phone call. Only call this after you have said goodbye and the caller has nothing further to add.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reason: {
        type: 'string',
        description: 'Brief reason the call is ending, e.g. "caller said goodbye", "enquiry logged".',
      },
    },
    required: [],
  },
};

export const TRANSFER_CALL_TOOL = {
  type: 'function',
  name: 'transfer_call',
  description:
    'Transfers the caller to a live team member. Only use this if the caller explicitly asks to speak to a ' +
    'person and a transfer is actually appropriate. If this fails, apologise and take a message instead.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reason: {
        type: 'string',
        description: 'Why the caller is being transferred.',
      },
    },
    required: [],
  },
};

// Builds the tool list for a given call. Transfer is only offered to the
// model when a real transfer destination is actually configured — matching
// the "never claim a capability the system doesn't have" rule.
export function buildDarrenTools({ transferAvailable } = {}) {
  const tools = [SUBMIT_LEAD_TOOL, END_CALL_TOOL];
  if (transferAvailable) tools.push(TRANSFER_CALL_TOOL);
  return tools;
}

export default buildDarrenTools;
