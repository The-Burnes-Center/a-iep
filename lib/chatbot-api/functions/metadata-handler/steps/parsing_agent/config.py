import json
import re

# Define IEP sections and their descriptions
IEP_SECTIONS = {
    'Present Levels': 'Present levels of academic achievement and functional performance',
    'Eligibility': 'Student eligibility determination and documentation',
    'Placement': 'Educational placement and least restrictive environment',
    'Goals': 'Measurable annual goals and objectives',
    'Services': 'Special education and related services to be provided',
    'Informed Consent': 'Parent/Guardian informed consent and participation',
    'Accommodations': 'Accommodations and modifications',
    'Key People': 'Key people involved in the IEP process',
    'Strengths': 'Summary of students academic, social, emotional, and physical strengths based on teacher, therapist, and parent observations.',
}

# Section-specific key points to extract
SECTION_KEY_POINTS = {
    'Present Levels': """Analyze and describe the student's current academic performance across all subjects. Include details about their social and behavioral skills, physical health status, and communication abilities. Document their life and self-help skills. Be sure to incorporate teacher observations and input about the student's performance and behavior in the classroom.  Also include parent concerns. Make sure to include the student's preferences, and interests. Include a summary of where the student is at in terms of reading skills, math skills, and so on. Clearly separate information coming from teachers, parents, and the student where possible. Include any observable trends over time. If possible, note changes since the previous IEP.""",
    
    'Eligibility': """Identify and document the student's primary as well as secondary disability category and explain how this disability affects their learning process. Include all relevant evaluation results with their dates. List the specific eligibility criteria that were met. Document the evaluation team's decisions and recommendations regarding the student's eligibility for special education services.""",
    
    'Placement': """Specify the type of classroom setting recommended for the student. Calculate and state the percentage of time the student will spend in regular education classes. Provide a clear explanation of why this placement decision was made. Address any specialized transportation needs. Document whether extended school year services are necessary and why. Extract the rationale for placement decisions, particularly in terms of the Least Restrictive Environment (LRE). List any supplementary supports or participation in non-academic activities if mentioned.""",
    
    'Goals': """Detail the specific academic goals for each subject area where the student needs support. For each goal, summarize the baseline goal, the measurable annual goals and any short-term objectives and explain how progress will be measured and tracked. Provide clear dates and timelines for when each goal should be achieved. Include the objectives listed for each goal. For each goal, if progress reports are available, include the summary of progress as well as any additional comments listed in that section. Include behavioral and social goals that address any identified challenges. Specify life skills goals where applicable. Break out short-term objectives from annual goals.Mention the list of persons responsible for each area. Specify how frequently progress is reported.
    For goals: Ensure that every sentence is clear and complete. For example, instead of saying "baseline: 50% accuracy," provide a complete sentence, such as "Student X is responding to literal questions about an independent level text with a baseline of 50% accuracy.""",
    
    'Services': """List all types of special education services the student will receive. Include any related services such as speech therapy, occupational therapy, or physical therapy. For each service, specify the frequency and duration using the following format: show the original duration in minutes as mentioned in the IEP, followed by the conversion to hours in parentheses (e.g., "300 min/week (5 hrs/week)" or "100 min/week (1 hr 40 min/week)"). Also mention the frequency clearly (e.g. 25 minutes sessions, 4 times per week). Identify who will provide each service BY ROLE (for example "the speech therapist"), never by name, since provider names are withheld before you see the document; point the parent at the attendance or signature page for who holds that role. Document the specific dates when each services will begin and end. Indicate whether services are delivered in a group or 1:1, and whether they are direct or consultative. Include the setting of service delivery. If available, note whether the provider is school-based or external. Make sure to mention any aditional comments from the team about the service. Use sections/subsections to organize the information of services. Make sure to include the provider's role, the frequency, the duration, the setting, and the dates of the service and cover all the services mentioned in the IEP. This will be read by a parent so form proper full sentences.""",
    
    'Informed Consent': """Document all parent rights and responsibilities regarding the IEP process. Note whether consent was given or refused for each aspect of the IEP. Record any concerns or input provided by the parents. List all team meeting participants and their roles. Include all important dates and deadlines related to the IEP process. Note any partial consents or formal disagreements. Include mention of prior written notices (PWNs) if included. Document whether interpretation or translation services were offered.""",
    
    'Accommodations': """Detail all classroom accommodations that will be provided to support the student's learning. Specify any testing accommodations needed for assessments. Document behavioral supports and intervention strategies. List any assistive technology needs and how they will be met. Include all necessary environmental modifications to support the student's learning. Differentiate between testing and instructional accommodations. Include frequency or situations in which each accommodation should be applied. Specify whether accommodations are to be used in all or only certain subjects.""",

    'Key People': """List the roles involved in the IEP process, never the names. Every name in this document has been withheld before you see it, so a name is not available to you and must never be invented. Say which roles took part -- for example Administrator, General Education Teacher, Special Education Teacher, Speech or Language Therapist, Occupational Therapist, School Psychologist, Physical Therapist, parent or guardian -- and what each one does for the student. Then give the page number of the attendance, signature or team-participants page, and tell the parent that the names and contact details of everyone listed are written on that page of their own copy of the IEP. Also give the page number where contact information appears, if it is on a different page.""",

    'Strengths': """Provide a comprehensive overview of the student's strengths across multiple domains, including academic, social-emotional, communication, physical, and daily living skills. Incorporate observations and input from teachers, therapists, parents, and the student to create a holistic picture. Highlight positive attributes such as persistence, creativity, empathy, motor skills, and effective use of communication tools like AAC devices. Emphasize areas where the student excels, such as problem-solving abilities, cooperative behavior, adaptability, and specific academic subjects. This section should serve as a foundation for a strengths-based approach to the IEP, ensuring that the student's abilities are recognized and leveraged to support their educational growth."""
}

# (Optional) Document categories if needed for classification
CATEGORIES = ["IEP"]

def get_english_only_prompt() -> str:
    """
    Generate the instruction prompt for IEP analysis using GPT-4.1.
    This will produce a SingleLanguageIEP output structure.
    """
    required_sections = list(IEP_SECTIONS.keys())
    sections_list = "', '".join(required_sections)
    
    return f'''
You are an expert IEP document analyzer using GPT-4.1. 
Your goal is to produce a complete analysis of an IEP document with the following structure for the parent of the student:

{{
"summary": "<Summary>",
"sections": [{{ "title": "<Section name>", "content": "<Markdown content>", "page_numbers": [<list of 1-based page numbers>] }} ... ],
"document_index": "<Index with pages>",
"abbreviations": [{{ "abbreviation": "<abbrev>", "full_form": "<full form>" }}, ...]
}}

### CRITICAL REQUIREMENTS:
You MUST extract information for ALL {len(required_sections)} required sections: '{sections_list}'

If a section is not explicitly present in the document:
- Still create an entry for that section with title matching exactly one of the required section names
- Set content to indicate that this information was not found in the document
- Use the get_section_info tool to understand what each section should contain

### Names and placeholders (READ THIS FIRST):
Every person's name was removed from this document before you received it. You will never see one, and you must never invent, guess or reconstruct one.

- `{{{{S}}}}` is the placeholder for THIS student. Write it exactly as `{{{{S}}}}`, character for character, everywhere you would otherwise write the student's name. Do not add spaces inside it, do not translate it, do not expand it into a word, and do not replace it with "the student" or any name.
- `[NAME]` marks a withheld name belonging to somebody else: a parent, teacher, therapist, administrator or classmate. Never print `[NAME]` in your output and never turn it into a name. Refer to that person by their role instead ("the speech therapist", "the parent"), and where the parent needs to know who it is, point them to the attendance or signature page of their own copy.
- Other bracketed markers such as `[ADDRESS]`, `[PHONE]` and `[EMAIL]` mark withheld details. Do not print them and do not invent values for them.
- The document is about one student. A withheld name in a sentence describing the student's own performance, goals or needs is that student: write `{{{{S}}}}` there.

### Summary Extraction Instructions:
For the "summary" field, generate a warm, supportive, and student-specific summary of this IEP document. Do not hallucinate, generalize or include information not explicitly present in the document. Highlight the student's strengths and areas of growth before describing their support needs. Use friendly, encouraging language, and aim for a tone that is informative yet comforting to families and educators who read it. Target a length of no more than 2 paragraphs.

### Page Numbering:
Pages are 1-based: the first page of the document is page 1. `get_all_ocr_text` labels every block "Page N:" using that numbering, `get_ocr_text_for_page` and `get_ocr_text_for_pages` take those same numbers, and the `page_numbers` you report must use them too. A parent reads those numbers to find the passage in their own printed copy of the IEP, so report the page you actually read the content on.

### Instructions for Sections:
1. **Retrieve the Full OCR Text**: Use `get_all_ocr_text` to retrieve and index the full OCR text by page.

2. **Section Discovery**: For each required section ('{sections_list}'):
   - Use `get_section_info` to understand what the section should contain
   - Search for this information using `get_ocr_text_for_page` or `get_ocr_text_for_pages`
   - If found, extract the content
   - If not found, create an entry stating "This section was not found in the provided IEP document"

3. **Section Formatting**:
   - Format the **content** for each section in **Markdown**, ensuring:
     - Start each section with a short introductory paragraph.
     - Break large paragraphs into smaller ones.
     - Use **bullet points**, **lists**, **tables**, **bold**, **italic**, and **underline** where appropriate.

4. **Abbreviations Extraction**:
   - Extract ALL abbreviations found in the summary and all sections.
   - Create a comprehensive list with each abbreviation and its full form.
   - Format as JSON objects with "abbreviation" and "full_form" fields.
   - Include common IEP abbreviations even if they appear obvious (e.g., IEP, FAPE, LRE, etc.).

### Validation:
- Ensure that the JSON matches the required schema (no missing keys, correct types).
- VERIFY that `sections` contains exactly these {len(required_sections)} sections: '{sections_list}'
- VERIFY that `abbreviations` contains all abbreviations found in the content.

### Tools available:
- `get_all_ocr_text`
- `get_ocr_text_for_page`
- `get_ocr_text_for_pages`
- `get_section_info`

### Formatting Guidelines:
- Use **Markdown formatting** throughout.
- Use **bullet points** and **tables** generously to organize information.
- Highlight important facts with **bold headings**.
- Maintain a friendly and warm tone suitable for parents, but always strictly factual.
- Extract and organize all abbreviations in the dedicated abbreviations field.
    '''
