import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export async function POST(req: Request) {
  const { gammaUrl, title, description, price } = await req.json();
  
  const supabase = createRouteHandlerClient({ cookies });
  
  // Get authenticated user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Launch Puppeteer with Chromium
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    
    const page = await browser.newPage();
    await page.goto(gammaUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    
    // Wait for slides to load
    await page.waitForSelector('[data-slide-index], .slide, [class*="slide"]', { timeout: 10000 });
    
    // Extract slide images
    const slides = await page.evaluate(() => {
      // Try multiple selectors for Gamma slides
      const selectors = ['[data-slide-index]', '.slide', '[class*="Slide"]'];
      let slideElements: NodeListOf<Element> | null = null;
      
      for (const selector of selectors) {
        slideElements = document.querySelectorAll(selector);
        if (slideElements.length > 0) break;
      }
      
      return Array.from(slideElements || []).map((el, index) => {
        // Try to find image in slide
        const img = el.querySelector('img');
        const imgSrc = img?.src || 
                      (el as HTMLElement).style.backgroundImage?.replace(/url\(["']?/, '').replace(/["']?\)/, '') ||
                      null;
        
        return {
          index: index + 1,
          imageUrl: imgSrc,
          text: el.textContent?.substring(0, 200) || null,
        };
      }).filter(s => s.imageUrl);
    });
    
    if (slides.length === 0) {
      await browser.close();
      return NextResponse.json({ error: 'No slides found in Gamma URL' }, { status: 400 });
    }
    
    // Create course
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .insert({
        title: title || 'Untitled Course',
        description: description || null,
        price_usd: price || 0,
        status: 'draft',
        gamma_source_url: gammaUrl,
        created_by: user.id,
      })
      .select()
      .single();
      
    if (courseError) {
      await browser.close();
      throw courseError;
    }
    
    // Download and upload slides
    for (const slide of slides) {
      try {
        // Fetch image
        const imageResponse = await fetch(slide.imageUrl!);
        if (!imageResponse.ok) continue;
        
        const imageBuffer = await imageResponse.arrayBuffer();
        const fileName = `course_${course.id}/slide_${slide.index}.png`;
        
        // Upload to Supabase Storage
        const { data: uploadData, error: uploadError } = await supabase
          .storage
          .from('slides')
          .upload(fileName, Buffer.from(imageBuffer), {
            contentType: 'image/png',
            upsert: true,
          });
          
        if (uploadError) {
          console.error('Error uploading slide:', uploadError);
          continue;
        }
        
        // Create slide record
        await supabase.from('slides').insert({
          course_id: course.id,
          slide_number: slide.index,
          image_path: fileName,
          transcript: slide.text,
        });
      } catch (error) {
        console.error(`Error processing slide ${slide.index}:`, error);
      }
    }
    
    await browser.close();
    
    return NextResponse.json({ 
      success: true, 
      courseId: course.id,
      slideCount: slides.length 
    });
    
  } catch (error: any) {
    console.error('Import error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to import Gamma presentation' }, 
      { status: 500 }
    );
  }
}
