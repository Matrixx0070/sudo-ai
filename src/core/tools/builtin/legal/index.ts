/**
 * Legal & Compliance toolkit — registers 1 legal tool into the ToolRegistry.
 *
 * Tools registered:
 *   legal.terms-generator — Generate Terms of Service, Privacy Policy, Cookie Policy
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { normalizeBrainText } from '../../../brain/brain-text.js';

const logger = createLogger('legal-builtin');

// ---------------------------------------------------------------------------
// Shared LLM helper
// ---------------------------------------------------------------------------

interface BrainLike {
  // Brain.chat() resolves to a STRING (not { content }). normalizeBrainText handles it
  // null-safely — the old `.content.trim()` crashed every call.
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
}

interface ConfigLike { brain?: BrainLike; }

async function askBrain(ctx: ToolContext, system: string, user: string): Promise<string> {
  const config = ctx.config as ConfigLike | undefined;
  if (!config?.brain) throw new Error('Brain (LLM) is not available. Ensure the brain module is configured.');
  const response = await config.brain.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  return normalizeBrainText(response).trim();
}

// ---------------------------------------------------------------------------
// legal.terms-generator
// ---------------------------------------------------------------------------

const termsGeneratorTool: ToolDefinition = {
  name: 'legal.terms-generator',
  description:
    'Generate legal documents: Terms of Service, Privacy Policy, Cookie Policy, EULA, or Refund Policy. Tailored to your business type, jurisdiction, and data practices. IMPORTANT: Output is a starting template — always have a qualified lawyer review before publishing.',
  category: 'legal',
  timeout: 120_000,
  parameters: {
    documentType: {
      type: 'string',
      required: true,
      description: 'Type of legal document to generate.',
      enum: ['terms-of-service', 'privacy-policy', 'cookie-policy', 'eula', 'refund-policy', 'disclaimer', 'nda'],
    },
    companyName: { type: 'string', required: true, description: 'Legal company or product name.' },
    productType: {
      type: 'string',
      required: true,
      description: 'Type of product or service.',
      enum: ['saas', 'ecommerce', 'mobile-app', 'website', 'marketplace', 'api', 'consulting', 'content-platform'],
    },
    jurisdiction: { type: 'string', description: 'Primary legal jurisdiction (e.g. "US - Delaware", "UK", "EU - GDPR", "Australia").', default: 'US' },
    website: { type: 'string', description: 'Website or app URL.' },
    email: { type: 'string', description: 'Legal/contact email address.' },
    dataCollected: { type: 'string', description: 'Types of user data collected (comma-separated, e.g. "email, name, payment info, usage analytics").' },
    thirdParties: { type: 'string', description: 'Third-party services used (e.g. "Stripe, Google Analytics, AWS, Intercom").' },
    hasMinors: { type: 'boolean', description: 'Whether the service is accessible to users under 13/18 (affects COPPA/GDPR minor clauses).', default: false },
    subscriptionBased: { type: 'boolean', description: 'Whether the service has paid subscriptions or recurring billing.', default: false },
    userContent: { type: 'boolean', description: 'Whether users can post or upload content.', default: false },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const documentType = params['documentType'] as string;
    const companyName = params['companyName'] as string | undefined;
    const productType = params['productType'] as string | undefined;
    const jurisdiction = (params['jurisdiction'] as string | undefined) ?? 'US';
    const website = (params['website'] as string | undefined) ?? '[WEBSITE_URL]';
    const email = (params['email'] as string | undefined) ?? '[CONTACT_EMAIL]';
    const dataCollected = (params['dataCollected'] as string | undefined) ?? 'email, name';
    const thirdParties = (params['thirdParties'] as string | undefined) ?? '';
    const hasMinors = (params['hasMinors'] as boolean | undefined) ?? false;
    const subscriptionBased = (params['subscriptionBased'] as boolean | undefined) ?? false;
    const userContent = (params['userContent'] as boolean | undefined) ?? false;

    logger.info({ session: ctx.sessionId, documentType, companyName }, 'legal.terms-generator invoked');

    if (!companyName?.trim()) return { success: false, output: 'companyName is required.' };
    if (!productType) return { success: false, output: 'productType is required.' };

    const system = `You are an experienced technology lawyer specialising in ${jurisdiction} law. Generate professional, comprehensive legal documents in plain English. Always include all required clauses for the jurisdiction. Mark placeholder sections with [SQUARE_BRACKETS].`;

    const contextBlock = `
Company: ${companyName}
Product type: ${productType}
Website: ${website}
Contact email: ${email}
Jurisdiction: ${jurisdiction}
Data collected: ${dataCollected}
${thirdParties ? `Third-party services: ${thirdParties}` : ''}
${hasMinors ? 'NOTE: Service may be accessed by minors — include age restriction and parental consent clauses.' : ''}
${subscriptionBased ? 'NOTE: Service has paid subscriptions — include billing, cancellation, and refund clauses.' : ''}
${userContent ? 'NOTE: Users can post content — include content licensing, takedown, and DMCA clauses.' : ''}
`;

    let prompt = '';

    switch (documentType) {
      case 'terms-of-service':
        prompt = `Generate a comprehensive Terms of Service agreement for:
${contextBlock}

Include sections:
1. Acceptance of Terms
2. Description of Service
3. User Accounts and Registration
4. Acceptable Use Policy (prohibited uses, content standards)
5. Intellectual Property Rights
${userContent ? '6. User Content and Licenses\n7. DMCA / Copyright Takedown\n8.' : '6.'}  Payment and Billing (${subscriptionBased ? 'subscription details, cancellation, refunds' : 'if applicable'})
${subscriptionBased ? '9.' : '7.'}  Limitation of Liability
${subscriptionBased ? '10.' : '8.'}  Disclaimer of Warranties
${subscriptionBased ? '11.' : '9.'}  Indemnification
${subscriptionBased ? '12.' : '10.'} Termination
${subscriptionBased ? '13.' : '11.'} Governing Law and Dispute Resolution
${subscriptionBased ? '14.' : '12.'} Changes to Terms
${subscriptionBased ? '15.' : '13.'} Contact Information

Use the effective date [EFFECTIVE_DATE]. Format as markdown with clear headings.`;
        break;

      case 'privacy-policy':
        prompt = `Generate a comprehensive Privacy Policy for:
${contextBlock}

Include sections:
1. Introduction and Scope
2. Information We Collect (${dataCollected})
3. How We Use Your Information
4. Legal Basis for Processing (especially for GDPR/EU users)
5. Information Sharing and Third Parties (${thirdParties || 'none'})
6. Cookies and Tracking Technologies
7. Data Retention
8. Data Security
9. Your Rights and Choices (GDPR rights, CCPA rights if applicable)
10. Children's Privacy (${hasMinors ? 'COPPA compliance required' : 'users must be 13+'})
11. International Data Transfers
12. Changes to This Policy
13. Contact Us / Data Controller Information

Format as markdown with clear headings. Date: [EFFECTIVE_DATE].`;
        break;

      case 'cookie-policy':
        prompt = `Generate a Cookie Policy for:
${contextBlock}

Include:
1. What Are Cookies
2. Types of Cookies We Use (essential, analytics, marketing, preference)
3. Third-Party Cookies (${thirdParties || 'list applicable services'})
4. Cookie Duration Table (name | type | purpose | expiry)
5. How to Control Cookies (browser settings, opt-out links)
6. Impact of Disabling Cookies
7. Updates to This Policy
8. Contact Information

Format as markdown. Date: [EFFECTIVE_DATE].`;
        break;

      case 'eula':
        prompt = `Generate an End User License Agreement (EULA) for:
${contextBlock}

Include:
1. Grant of License
2. Restrictions on Use
3. Intellectual Property
4. Updates and Modifications
5. Termination of License
6. Disclaimer of Warranties
7. Limitation of Liability
8. Governing Law

Format as markdown. Date: [EFFECTIVE_DATE].`;
        break;

      case 'refund-policy':
        prompt = `Generate a Refund and Cancellation Policy for:
${contextBlock}

Include:
1. Eligibility for Refunds
2. Refund Request Process and Timeline
3. Non-Refundable Items/Services
4. Subscription Cancellation Policy
5. Partial Refunds
6. Chargebacks
7. Contact Information for Refund Requests

Format as markdown. Date: [EFFECTIVE_DATE].`;
        break;

      case 'disclaimer':
        prompt = `Generate a legal Disclaimer for:
${contextBlock}

Include:
1. General Disclaimer
2. No Professional Advice Disclaimer (if applicable)
3. Accuracy Disclaimer
4. External Links Disclaimer
5. Limitation of Liability
6. Jurisdiction

Format as markdown. Date: [EFFECTIVE_DATE].`;
        break;

      case 'nda':
        prompt = `Generate a mutual Non-Disclosure Agreement (NDA) template for ${companyName}:
Jurisdiction: ${jurisdiction} | Contact: ${email}

Include:
1. Definition of Confidential Information
2. Obligations of Receiving Party
3. Exclusions from Confidentiality
4. Term and Termination
5. Return of Information
6. Remedies
7. Governing Law
8. Signature Block (both parties)

Format as markdown with [PARTY_A], [PARTY_B], [EFFECTIVE_DATE] placeholders.`;
        break;

      default:
        return { success: false, output: `Unknown document type: ${documentType}` };
    }

    try {
      const output = await askBrain(ctx, system, prompt);
      const disclaimer = '\n\n---\n**IMPORTANT LEGAL NOTICE:** This document was generated by AI and is provided as a template starting point only. It does not constitute legal advice. You should have a qualified attorney in your jurisdiction review and customise this document before publishing or relying on it.';
      const finalOutput = output + disclaimer;
      logger.info({ documentType, companyName }, 'Legal document generated');
      return {
        success: true,
        output: finalOutput,
        data: { documentType, companyName, jurisdiction, charCount: finalOutput.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ documentType, err: msg }, 'legal.terms-generator error');
      return { success: false, output: `Terms generator error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const LEGAL_TOOLS: ToolDefinition[] = [
  termsGeneratorTool,
];

/**
 * Register all legal tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerLegalTools(registry: ToolRegistry): void {
  logger.info({ count: LEGAL_TOOLS.length }, 'Registering legal tools');
  for (const tool of LEGAL_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: LEGAL_TOOLS.length }, 'Legal tools registered');
}
