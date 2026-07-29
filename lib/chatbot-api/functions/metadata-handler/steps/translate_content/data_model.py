from typing import List
from pydantic import BaseModel, Field

# =============================================================================
# CORE COMPONENT MODELS
# =============================================================================

class AbbreviationLegend(BaseModel):
    """Abbreviation legend entry with abbreviation and its full form"""
    abbreviation: str = Field(..., description="The abbreviation or acronym")
    full_form: str = Field(..., description="The full form of the abbreviation")


# =============================================================================
# TRANSLATION-SPECIFIC MODELS
# =============================================================================

class TranslationSectionContent(BaseModel):
    """Section content for translations (simplified structure)"""
    title: str
    content: str
    page_numbers: List[int]
