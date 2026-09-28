export interface Source {
  id: string;
  name: string;
  category: string;
  url: string;
}

// Google News RSS search, used for outlets that don't publish a usable RSS feed of their own.
const googleNews = (query: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

const CATALOG: Record<string, Array<[id: string, name: string, url: string]>> = {
  "General News": [
    ["1", "World News (BBC)", "https://feeds.bbci.co.uk/news/world/rss.xml"],
    ["2", "Business & Finance (Reuters)", googleNews("site:reuters.com business")],
    ["3", "US Politics (PBS)", "https://www.pbs.org/newshour/feeds/rss/politics"],
  ],
  "Business & Global Finance": [
    ["4", "Bloomberg Markets", "https://feeds.bloomberg.com/markets/news.rss"],
    ["5", "Reuters Business News", googleNews("site:reuters.com markets")],
    ["6", "MarketWatch Top Stories", "https://feeds.content.dowjones.io/public/rss/mw_topstories"],
    ["7", "CNBC Market News", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069"],
    ["8", "The Wall Street Journal", "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain"],
    ["9", "Financial Times", "https://www.ft.com/rss/home"],
    ["10", "Harvard Business Review", "https://feeds.hbr.org/harvardbusiness"],
    ["11", "Fast Company", "https://www.fastcompany.com/latest/rss"],
    ["12", "Inc. Magazine", "https://www.inc.com/rss/"],
    ["13", "Forbes Top Stories", "https://www.forbes.com/business/feed/"],
  ],
  "Technology & Cyber Security": [
    ["14", "MIT Technology Review", "https://www.technologyreview.com/feed/"],
    ["15", "VentureBeat", "https://venturebeat.com/feed/"],
    ["16", "The Hacker News", "https://feeds.feedburner.com/TheHackersNews"],
    ["17", "Dark Reading", "https://www.darkreading.com/rss.xml"],
    ["18", "Bleeping Computer", "https://www.bleepingcomputer.com/feed/"],
    ["19", "The Verge", "https://www.theverge.com/rss/index.xml"],
    ["20", "Engadget", "https://www.engadget.com/rss.xml"],
    ["21", "TechCrunch", "https://techcrunch.com/feed/"],
    ["22", "Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"],
    ["23", "ZDNET", "https://www.zdnet.com/news/rss.xml"],
  ],
  "Science & Biotechnology": [
    ["24", "Nature News", "https://www.nature.com/nature.rss"],
    ["25", "Science Magazine News", "https://www.science.org/rss/news_current.xml"],
    ["26", "New Scientist", "https://www.newscientist.com/feed/home/"],
    ["27", "Fierce Pharma", "https://www.fiercepharma.com/rss/xml"],
    ["28", "BioPharma Dive", "https://www.biopharmadive.com/feeds/news/"],
    ["29", "Endpoints News", "https://endpts.com/feed/"],
    ["30", "STAT News", "https://www.statnews.com/feed/"],
    ["31", "Phys.org", "https://phys.org/rss-feed/"],
    ["32", "Medscape Medical News", "https://www.medscape.com/cx/rssfeeds/2700.xml"],
    ["33", "EurekAlert!", "https://www.eurekalert.org/rss.xml"],
  ],
  "Health & Fitness": [
    ["34", "Mayo Clinic News Network", "https://newsnetwork.mayoclinic.org/feed/"],
    ["35", "Harvard Health Publishing", "https://www.health.harvard.edu/blog/feed"],
    ["36", "WebMD Health News", "https://rssfeeds.webmd.com/rss/rss.aspx?RSSSource=RSS_PUBLIC"],
    ["37", "Medical News Today", googleNews("site:medicalnewstoday.com")],
    ["38", "The New York Times Well", "https://rss.nytimes.com/services/xml/rss/nyt/Well.xml"],
    ["39", "Experience Life", "https://experiencelife.lifetime.life/feed/"],
    ["40", "BarBend (Strength Training)", "https://barbend.com/feed/"],
    ["41", "Runner's World", "https://www.runnersworld.com/rss/all.xml/"],
    ["42", "STAT News (Health)", "https://www.statnews.com/category/health/feed/"],
    ["43", "Tufts Health & Nutrition Letter", "https://www.nutritionletter.tufts.edu/feed/"],
    ["44", "NPR Shots", "https://feeds.npr.org/103537970/rss.xml"],
  ],
  "Sports": [
    ["45", "Soccer / Football (BBC)", "https://feeds.bbci.co.uk/sport/football/rss.xml"],
    ["46", "MLS Soccer (ESPN)", googleNews("MLS site:espn.com")],
    ["47", "Champions League (BBC)", "https://feeds.bbci.co.uk/sport/football/champions-league/rss.xml"],
    ["48", "Olympic News (BBC)", "https://feeds.bbci.co.uk/sport/olympics/rss.xml"],
    ["49", "World Cup News (ESPN)", googleNews('"World Cup" site:espn.com')],
    ["50", "NFL Football (CBS)", "https://www.cbssports.com/rss/headlines/nfl/"],
    ["51", "College Football (CBS)", "https://www.cbssports.com/rss/headlines/college-football/"],
    ["52", "NBA Basketball (CBS)", "https://www.cbssports.com/rss/headlines/nba/"],
    ["53", "MLB Baseball (CBS)", "https://www.cbssports.com/rss/headlines/mlb/"],
    ["54", "NHL Hockey (CBS)", "https://www.cbssports.com/rss/headlines/nhl/"],
    ["55", "PGA Tour Golf (ESPN)", "https://www.espn.com/espn/rss/golf/news"],
    ["56", "Tennis News (ESPN)", "https://www.espn.com/espn/rss/tennis/news"],
    ["57", "Cricket News (ESPN Cricinfo)", "https://www.espncricinfo.com/rss/content/story/feeds/0.xml"],
    ["58", "Ultimate Frisbee (Ultiworld)", "https://ultiworld.com/feed/"],
    ["59", "College Soccer (TopDrawerSoccer)", googleNews("site:topdrawersoccer.com college")],
    ["60", "College Basketball (CBS)", "https://www.cbssports.com/rss/headlines/college-basketball/"],
    ["61", "College Wrestling (InterMat)", googleNews("site:intermatwrestle.com")],
    ["62", "College Hockey (USCHO)", "https://www.uscho.com/feed/"],
  ],
};

export const SOURCES: Source[] = Object.entries(CATALOG).flatMap(([category, rows]) =>
  rows.map(([id, name, url]) => ({ id, name, category, url })),
);

export const SOURCES_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

export const CATEGORIES = Object.keys(CATALOG);
