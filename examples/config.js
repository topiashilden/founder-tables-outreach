// Example configuration for <founder-tables-outreach>. Topics are what a search can be about: a job-title rule, a
// company-name rule, and words the prompt reader uses to pick a topic. Add your own; see README.md.
window.FT_EXAMPLE_CONFIG = {
  id: "example",
  title: "Who are you looking for in your community’s network?",
  simple: true,
  signature: "",
  placeholder: "A founder dinner in Stockholm, a CTO for a portfolio company…",
  examples: [],
  topics: [
    { key: "founders", label: "Founders", topic: "founders", why: "builds a company", default: true, plain: true, keywords: ["founder","founders","ceo","startup","startups"], match: { title: /founder|\bceo\b|chief executive/i, org: null, req: "title" } },
    { key: "ai", label: "Building AI products", topic: "building AI products", why: "ships AI in production", keywords: ["artificial intelligence","machine learning","software","data"], match: { title: /machine learning|\bml\b|\bai\b|data scien|\bcto\b|head of data/i, org: /\bai\b|analytics/i, req: "title" } },
    { key: "regulated", label: "Regulation & approvals", topic: "getting through regulation and approvals", why: "has taken products through approvals and policy", keywords: ["regulatory","approval","compliance","policy","medtech","health"], match: { title: /regulat|compliance|policy|medical affairs|legal|counsel|quality/i, org: /notified|agency|authority|policy/i, req: "title" } },
    { key: "deeptech", label: "Long R&D, big funding rounds", topic: "long R&D and big funding rounds", why: "funds or runs long R&D", keywords: ["deep tech","research","r&d","science","funding","investors"], match: { title: /partner|investment|professor|research|r&d|scien/i, org: /fund|capital|ventures|institute|universit/i, req: "both" } },
    { key: "hardware", label: "Scaling hardware", topic: "scaling hardware", why: "has scaled physical production", keywords: ["hardware","manufacturing","production","robotics","supply chain"], match: { title: /manufactur|production|supply chain|hardware|operations/i, org: /robot|batter|motors|hardware|steel/i, req: "title" } },
    { key: "carbon", label: "Measuring and proving impact", topic: "measuring and proving impact", why: "works on impact data and reporting every day", keywords: ["carbon","emissions","esg","reporting","csrd","climate data"], match: { title: /esg|sustainab|climate|carbon|\blca\b|csrd|impact/i, org: /climate|carbon/i, req: "title" } },
    { key: "industrial", label: "Selling to heavy industry", topic: "selling to heavy industry", why: "knows how heavy industry buys", keywords: ["industry","industrial","heavy industry","manufacturing","steel","cement","chemicals","factories","procurement"], match: { title: /procure|purchas|sourcing|plant|production|operations|energy/i, org: /steel|cement|paper|chemic|mining|metal|industri|motors|batter|forest/i, req: "org" } },
    { key: "grid", label: "Working with utilities & the grid", topic: "working with utilities and the grid", why: "sees the grid from the utility side", keywords: ["energy","utilities","grid","power","electricity","hydrogen","batteries","solar","wind","fusion"], match: { title: /grid|flexib|energy trading|power|energy/i, org: /kraft|power|energi|elnät|utility|utilities|grid|energy/i, req: "any" } },
    { key: "consumer", label: "Growing with consumers", topic: "growing with consumers", why: "has grown a consumer brand", keywords: ["consumer","brand","retail","b2c","growth"], match: { title: /\bcmo\b|brand|growth|marketing|consumer/i, org: /home|foods|apparel|consumer/i, req: "title" } },
    { key: "marketplace", label: "Two-sided marketplaces", topic: "building two-sided marketplaces", why: "has run a marketplace", keywords: ["marketplace","platform","sharing","rental"], match: { title: /marketplace|community|\bcoo\b/i, org: /marketplace|delning|sharing|rental/i, req: "any" } },
    { key: "public", label: "Selling to the public sector", topic: "selling to the public sector", why: "knows how the public sector buys", keywords: ["public sector","government","municipality","cities","procurement"], match: { title: /public sector|public|procurement|government|innovation/i, org: /municipal|region|city|kommun|government|ministry|agency/i, req: "any" } },
  ],
};
