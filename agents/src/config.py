from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime config for the agent worker, loaded from env / .env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    gcp_project_id: str = "tmcai-491811"
    gcp_location: str = "us-central1"

    platform_api_url: str = "http://host.docker.internal:4002"
    platform_api_token: str = ""

    topic_feed_raw: str = "tmcai-feed-raw"
    topic_openitems_scored: str = "tmcai-openitems-scored"
    topic_actions_approved: str = "tmcai-actions-approved"
    topic_steering_snapshot: str = "tmcai-steering-snapshot"

    sub_feed_curator: str = "tmcai-feed-raw-sub"
    sub_triage_analyst: str = "tmcai-openitems-scored-sub"
    sub_action_executor: str = "tmcai-actions-approved-sub"
    sub_steering_analyst: str = "tmcai-steering-snapshot-sub"

    redis_host: str = "127.0.0.1"
    redis_port: int = 6379
    redis_auth: str = ""

    gemini_pro_model: str = "gemini-2.5-pro"
    gemini_flash_model: str = "gemini-2.5-flash"
    gemini_api_key: str = ""

    # External Knowledge APIs (TMC Context + KNOW)
    tmc_context_api_url: str = ""      # e.g. https://context.tmc.ai/api/v1
    tmc_context_api_key: str = ""      # Bearer token or API key
    know_api_url: str = ""             # e.g. https://know.tmc.ai/api/v1
    know_api_key: str = ""             # Bearer token or API key

    agent_id: str = "brain-orchestrator"


@lru_cache
def get_settings() -> Settings:
    return Settings()
