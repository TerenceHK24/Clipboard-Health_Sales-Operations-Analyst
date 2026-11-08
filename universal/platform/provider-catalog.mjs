/** Templates show official capability shapes; they never imply active, verified installations. */
export const PROVIDERS=Object.freeze([
 {id:'slack',name:'Slack',group:'Communication',auth:'Bot OAuth',status:'adapter',capabilities:['auth.test','chat.postMessage','views.open','interactive approval'],doc:'https://api.slack.com/'},
 {id:'teams',name:'Microsoft Teams',group:'Communication',auth:'Entra ID + Bot Framework',status:'template',capabilities:['Adaptive Cards','Action.Execute','bot callback'],doc:'https://learn.microsoft.com/microsoftteams/platform/'},
 {id:'gmail',name:'Gmail',group:'Email',auth:'Google OAuth',status:'template',capabilities:['users.messages.send','users.messages.get'],doc:'https://developers.google.com/workspace/gmail/api/reference/rest'},
 {id:'outlook',name:'Microsoft Outlook / Graph',group:'Email',auth:'Microsoft Graph OAuth',status:'template',capabilities:['sendMail','messages.read'],doc:'https://learn.microsoft.com/graph/api/overview'},
 {id:'googlecalendar',name:'Google Calendar',group:'Calendar',auth:'Google OAuth',status:'template',capabilities:['events.list','events.insert'],doc:'https://developers.google.com/workspace/calendar/api/v3/reference'},
 {id:'hubspot',name:'HubSpot',group:'CRM',auth:'OAuth / Private App',status:'generic-rest',capabilities:['crm.objects.read','crm.objects.write'],doc:'https://developers.hubspot.com/docs/api-reference'},
 {id:'salesforce',name:'Salesforce',group:'CRM',auth:'OAuth',status:'generic-rest',capabilities:['sobjects.describe','query','update'],doc:'https://developer.salesforce.com/docs/apis'},
 {id:'xero',name:'Xero',group:'Accounting',auth:'OAuth',status:'template',capabilities:['contacts','invoices'],doc:'https://developer.xero.com/documentation/'},
 {id:'quickbooks',name:'QuickBooks Online',group:'Accounting',auth:'OAuth',status:'template',capabilities:['customers','invoices'],doc:'https://developer.intuit.com/app/developer/qbo/docs'},
 {id:'jira',name:'Jira',group:'Project Management',auth:'OAuth / API Token',status:'generic-rest',capabilities:['issues','comments'],doc:'https://developer.atlassian.com/cloud/jira/platform/rest/v3/'},
 {id:'mcp',name:'Any trusted MCP Server',group:'Custom',auth:'Per-server',status:'adapter',capabilities:['listTools','callTool'],doc:'https://modelcontextprotocol.io/'},
 {id:'rest',name:'Generic REST / OpenAPI',group:'Custom',auth:'Vault ref / OAuth',status:'adapter',capabilities:['schema discovery','read','approved write'],doc:'https://spec.openapis.org/oas/latest.html'},
 {id:'database',name:'SQL Database',group:'Databases',auth:'Database user/role',status:'sdk-needed',capabilities:['read-only query','schema profiling'],doc:'https://www.postgresql.org/docs/'},
]);
export const provider=(id)=>PROVIDERS.find(p=>p.id===id)||null;
