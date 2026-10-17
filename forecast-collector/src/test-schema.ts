import migration from "../migrations/0025_naver_page_policy.sql?raw";
import judgments from "../migrations/0026_source_judgment_evidence.sql?raw";
import bootstrap from "../schema.sql?raw";

export default `${bootstrap}\n${migration}\n${judgments}`;
