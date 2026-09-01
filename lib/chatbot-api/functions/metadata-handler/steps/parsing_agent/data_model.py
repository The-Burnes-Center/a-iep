from typing import List
from pydantic import BaseModel, Field, model_validator, field_validator
from config import IEP_SECTIONS

# =============================================================================
# CORE COMPONENT MODELS
# =============================================================================

class AbbreviationLegend(BaseModel):
    """Abbreviation legend entry with abbreviation and its full form"""
    abbreviation: str = Field(..., description="The abbreviation or acronym")
    full_form: str = Field(..., description="The full form of the abbreviation")


class SectionContent(BaseModel):
    """Content for a single IEP section with validation"""
    title: str = Field(
        ...,
        description="Section name - must match one of: " + ", ".join(IEP_SECTIONS.keys())
    )
    content: str = Field(..., description="Section content in markdown format")
    # Parents read these to find the passage in their own copy of the IEP, so
    # they are 1-based page numbers, the same numbering the OCR tools use.
    page_numbers: List[int] = Field(..., description="List of page numbers where content was found, make sure to include all the pages where the section content was found. Page numbers are 1-based: the first page of the document is page 1.")

    @field_validator('title')
    @classmethod
    def validate_title(cls, v):
        if v not in IEP_SECTIONS:
            raise ValueError(f"Invalid section name: {v}. Must be one of: {', '.join(IEP_SECTIONS.keys())}")
        return v


# =============================================================================
# MAIN OUTPUT MODELS
# =============================================================================

class SingleLanguageIEP(BaseModel):
    """Complete IEP data structure for a single language (typically English)"""
    summary: str = Field(..., description="Summary of the IEP for this language")
    sections: List[SectionContent] = Field(..., description="All IEP sections for this language")
    document_index: str = Field(..., description="Document index (Table of Contents) for this language")
    abbreviations: List[AbbreviationLegend] = Field(..., description="List of all abbreviations and their full forms found in the summary and sections")

    @model_validator(mode='after')
    @classmethod
    def validate_complete_sections(cls, model):
        """Ensure all required IEP sections are present"""
        section_titles = [section.title for section in model.sections]
        missing_titles = set(IEP_SECTIONS.keys()) - set(section_titles)
        extra_titles = set(section_titles) - set(IEP_SECTIONS.keys())

        if missing_titles:
            raise ValueError(f"Missing required sections: {missing_titles}")
        if extra_titles:
            raise ValueError(f"Unknown sections: {extra_titles}")

        return model

    class Config:
        validate_assignment = True
        extra = "forbid"
