import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Gamma MCP tool definition
const gammaCreateTool = {
  description: 'Create a new Gamma presentation with AI-generated content',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The title of the presentation'
      },
      description: {
        type: 'string',
        description: 'Description of what the presentation should cover'
      },
      format: {
        type: 'string',
        enum: ['presentation', 'document', 'webpage'],
        description: 'The format of the content'
      },
      numberOfSlides: {
        type: 'number',
        description: 'Number of slides to generate (5-20 recommended)'
      },
      textDensity: {
        type: 'string',
        enum: ['brief', 'medium', 'extensive'],
        description: 'How much text per slide'
      },
      tone: {
        type: 'string',
        description: 'Tone of the content (professional, casual, educational, etc.)'
      },
      theme: {
        type: 'string',
        description: 'Visual theme/style for the presentation'
      }
    },
    required: ['title', 'description', 'format']
  }
};

export async function POST(req: Request) {
  try {
    const { topic, numSlides = 10, textDensity = 'medium', tone = 'educational' } = await req.json();
    
    const supabase = createRouteHandlerClient({ cookies });
    
    // Get authenticated user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Use AI to generate course structure
    const { text, toolCalls } = await generateText({
      model: openai('gpt-4'),
      tools: {
        gamma_create: gammaCreateTool
      },
      prompt: `Create a comprehensive ${numSlides}-slide educational course about "${topic}".
      
Requirements:
- Format: presentation
- Text density: ${textDensity}
- Tone: ${tone}
- Target audience: Online learners

Generate the course outline and structure.`,
      maxToolRoundtrips: 1
    });

    // Extract the AI-generated content
    const generatedContent = {
      title: topic,
      description: text.substring(0, 500),
      slides: parseSlidesFromAIResponse(text, numSlides)
    };

    // Create course in Supabase
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .insert({
        title: generatedContent.title,
        description: generatedContent.description,
        price_usd: 0,
        status: 'draft',
        created_by: user.id,
      })
      .select()
      .single();

    if (courseError) {
      throw courseError;
    }

    // Create placeholder slides
    for (let i = 1; i <= numSlides; i++) {
      const slideContent = generatedContent.slides[i - 1] || `Slide ${i}`;
      
      await supabase.from('slides').insert({
        course_id: course.id,
        slide_number: i,
        image_path: `placeholder_slide_${i}.png`,
        transcript: slideContent,
      });
    }

    return NextResponse.json({
      success: true,
      courseId: course.id,
      message: `AI course "${topic}" created with ${numSlides} slides. Upload slide images and audio to complete.`,
      outline: generatedContent.slides
    });

  } catch (error: any) {
    console.error('AI Course creation error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create AI course' },
      { status: 500 }
    );
  }
}

// Helper to parse slide content from AI response
function parseSlidesFromAIResponse(text: string, numSlides: number): string[] {
  const slides: string[] = [];
  
  // Try to extract slide titles/content
  const lines = text.split('\n');
  let currentSlide = 0;
  
  for (const line of lines) {
    // Look for slide indicators ("Slide 1:", "1.", etc.)
    const slideMatch = line.match(/^(?:Slide\s*)?(\d+)[:.\-]\s*(.+)/i);
    if (slideMatch && currentSlide < numSlides) {
      slides.push(slideMatch[2].trim());
      currentSlide++;
    }
  }
  
  // Fill remaining slots with generic titles
  while (slides.length < numSlides) {
    slides.push(`Slide ${slides.length + 1}`);
  }
  
  return slides.slice(0, numSlides);
}
