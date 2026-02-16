import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

// Lazy initialization - only create client when needed
let perplexity: OpenAI | null = null;

function getPerplexityClient(): OpenAI {
  if (!perplexity) {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error('PERPLEXITY_API_KEY environment variable is missing');
    }
    perplexity = new OpenAI({
      apiKey,
      baseURL: 'https://api.perplexity.ai',
    });
  }
  return perplexity;
}

export async function POST(req: Request) {
  try {
    const { topic, numSlides = 10, textDensity = 'medium', tone = 'educational' } = await req.json();
    
    const supabase = createRouteHandlerClient({ cookies });
    
    // Get authenticated user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Initialize Perplexity client
    const client = getPerplexityClient();

    // Use Perplexity to generate course structure
    const response = await client.chat.completions.create({
      model: 'llama-3.1-sonar-large-128k-online',
      messages: [
        {
          role: 'system',
          content: 'You are an expert course creator who designs engaging educational content. Create well-structured courses with clear learning objectives.'
        },
        {
          role: 'user',
          content: `Create a comprehensive ${numSlides}-slide educational course about "${topic}".

Requirements:
- Format: Presentation slides
- Text density: ${textDensity} (brief = bullet points, medium = paragraphs, extensive = detailed explanations)
- Tone: ${tone}
- Target audience: Online learners

Please provide:
1. A compelling course title
2. A brief description (2-3 sentences)
3. An outline with ${numSlides} slide titles/topics

Format the outline as:
Slide 1: [Title]
Slide 2: [Title]
etc.`
        }
      ],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const generatedText = response.choices[0]?.message?.content || '';

    // Extract the AI-generated content
    const generatedContent = {
      title: extractTitle(generatedText) || topic,
      description: extractDescription(generatedText),
      slides: parseSlidesFromAIResponse(generatedText, numSlides)
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
      message: `AI course "${generatedContent.title}" created with ${numSlides} slides. Upload slide images and audio to complete.`,
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

// Helper to extract title from AI response
function extractTitle(text: string): string | null {
  // Look for "Title:" or first line
  const titleMatch = text.match(/(?:Title:|Course Title:)\s*(.+)/i) || text.match(/^(.+)$/m);
  return titleMatch ? titleMatch[1].trim() : null;
}

// Helper to extract description from AI response
function extractDescription(text: string): string {
  // Look for "Description:" or first paragraph after title
  const descMatch = text.match(/(?:Description:)\s*([\s\S]+?)(?=\n\n|Slide 1:)/i);
  if (descMatch) {
    return descMatch[1].trim().substring(0, 500);
  }
  // Fallback: use first 500 characters
  return text.substring(0, 500).replace(/\n/g, ' ');
}

// Helper to parse slide content from AI response
function parseSlidesFromAIResponse(text: string, numSlides: number): string[] {
  const slides: string[] = [];
  
  // Try to extract slide titles/content
  const lines = text.split('\n');
  
  for (const line of lines) {
    // Look for slide indicators ("Slide 1:", "1.", etc.)
    const slideMatch = line.match(/^(?:Slide\s*)?(\d+)[:.\-]\s*(.+)/i);
    if (slideMatch) {
      const slideNum = parseInt(slideMatch[1]);
      if (slideNum <= numSlides) {
        slides[slideNum - 1] = slideMatch[2].trim();
      }
    }
  }
  
  // Fill remaining slots with generic titles
  for (let i = 0; i < numSlides; i++) {
    if (!slides[i]) {
      slides[i] = `Slide ${i + 1}`;
    }
  }
  
  return slides.slice(0, numSlides);
}
